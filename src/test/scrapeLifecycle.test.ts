import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/** Isolated processes test the actual entrypoint/loop without live network or SQLite. */
async function runScenario(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pixiv-lifecycle-'));
  const root = resolve('.');
  const script = `
    import { mock } from 'bun:test';
    import fs from 'fs';
    const root = ${JSON.stringify(root)};
    const scenario = ${JSON.stringify(scenario)};
    const dir = ${JSON.stringify(dir)};
    const event = (name) => fs.appendFileSync(dir + '/events', name + '\\n');
    const errors = await import(root + '/src/fetch/errors.ts');
    const originalTimer = setTimeout;
    if (scenario === 'forced-timeout') {
      globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 30000 ? 30 : ms, ...args);
    }
    let query = 0;
    let writes = 0;
    mock.module('@prisma/client', () => ({ PrismaClient: class {
      pixivArticle = {
        count: async () => { event('count'); return 10; },
        update: async () => {
          event('write'); writes++;
          if (scenario === 'write-failed') throw new Error('private-write-detail');
          if (scenario === 'timeout-write-failed' && writes === 2) {
            await new Promise(resolve => setTimeout(resolve, 50));
            throw new Error('private-late-write-detail');
          }
        },
        delete: async () => { event('delete'); if (scenario === 'delete-failed') throw new Error('private-delete-detail'); },
      };
      $queryRaw = async () => query++ === 0
        ? ['ok', 'missing', '..', 'last'].map(tag_name => ({ tag_name })) : [];
      $queryRawUnsafe = async () => { event('checkpoint'); if (scenario === 'cleanup-failed') throw new Error('private-checkpoint-detail'); };
      $disconnect = async () => { event('disconnect'); };
    }}));
    mock.module(root + '/src/fetch/fetchURL.ts', () => ({
      closeSession: async () => { event('close'); if (scenario === 'cleanup-failed') throw new Error('private-close-detail'); },
    }));
    mock.module(root + '/src/scrape/scrapeSitemap.ts', () => ({ scrapeSitemap: async () => {
      event('sitemap');
      if (scenario === 'timeout-sitemap-failed') {
        await new Promise(resolve => setTimeout(resolve, 50));
        throw new SyntaxError('private-late-sitemap-detail');
      }
      if (scenario === 'sitemap-failed') throw new SyntaxError('private-html-detail');
    }}));
    class ArticleNotFoundError extends Error {}
    mock.module(root + '/src/scrape/scrapeSingleArticleInfo.ts', () => ({
      ArticleNotFoundError,
      scrapeSingleArticleInfo: async (tag) => {
        event('fetch:' + tag);
        if (tag === 'missing') {
          if (scenario === 'cloudflare') throw new errors.CloudflareError();
          if (scenario === 'rate-limit') throw new errors.HttpError(429, 'private-header-detail');
          if (scenario === 'fetch-timeout') throw new errors.FetchTimeoutError(true);
          if (scenario === 'fatal-error') throw new SyntaxError('private-body-detail');
          if (scenario === 'timeout-parse-failed') {
            await new Promise(resolve => setTimeout(resolve, 50));
            throw new SyntaxError('private-late-parser-detail');
          }
          if (['timeout', 'forced-timeout'].includes(scenario)) {
            await new Promise(resolve => setTimeout(resolve, scenario === 'forced-timeout' ? 1000 : 50));
          } else if (['sigint', 'sigterm'].includes(scenario)) {
            process.emit(scenario === 'sigint' ? 'SIGINT' : 'SIGTERM');
            process.emit(scenario === 'sigint' ? 'SIGINT' : 'SIGTERM');
            await new Promise(resolve => setTimeout(resolve, 10));
          } else if (scenario !== 'timeout-write-failed') throw new ArticleNotFoundError();
        }
        return { reading: '', header: [tag], mainText: '', summary: '', parent: null,
          related_tags: [], main_illst_url: '', updated_at: '' };
      }
    }));
    const { main } = await import(root + '/src/index.ts');
    process.chdir(dir);
    fs.writeFileSync('total.txt', 'stale');
    process.argv = ['bun', 'index.ts', ...((scenario.startsWith('timeout') || scenario === 'forced-timeout') ? ['--timeout=10'] : [])];
    await main();
  `;
  try {
    const child = Bun.spawn([process.execPath, '--eval', script], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const reportPath = join(dir, 'scrape-outcome.json');
    if (!existsSync(reportPath))
      throw new Error(`Missing report: ${stdout}\n${stderr}`);
    return {
      code,
      report: JSON.parse(readFileSync(reportPath, 'utf8')),
      events: readFileSync(join(dir, 'events'), 'utf8').trim().split('\n'),
      marker: existsSync(join(dir, 'total.txt')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('entrypoint reports actual writes, 404 deletion, ignored tags and completion', async () => {
  const result = await runScenario('complete');
  expect(result.code).toBe(0);
  expect(result.report.status).toBe('complete');
  expect(result.report.counts).toEqual({
    total: 4,
    processed: 4,
    successful: 2,
    failed: 0,
    notFound: 1,
    skipped: 1,
  });
  expect(result.events.slice(-4)).toEqual([
    'count',
    'checkpoint',
    'disconnect',
    'close',
  ]);
  expect(result.marker).toBe(true);
});

for (const scenario of [
  'fatal-error',
  'write-failed',
  'delete-failed',
  'sitemap-failed',
  'cleanup-failed',
]) {
  test(`entrypoint publishes ${scenario}, cleans up and exits nonzero`, async () => {
    const result = await runScenario(scenario);
    expect(result.code).toBe(1);
    expect(result.report.status).toBe('partial');
    expect(result.report.finalized).toBe(true);
    expect(result.report.stopReason).toBe(
      scenario === 'cleanup-failed' ? 'cleanup-failed' : 'fatal-error',
    );
    expect(JSON.stringify(result.report)).not.toContain('private-');
    expect(result.events.slice(-4)).toEqual([
      'count',
      'checkpoint',
      'disconnect',
      'close',
    ]);
    expect(result.marker).toBe(false);
    if (scenario === 'sitemap-failed') {
      expect(result.report.stoppedPhase).toBe('sitemap');
      expect(result.report.counts.processed).toBe(0);
    } else if (scenario !== 'cleanup-failed')
      expect(result.report.counts.failed).toBe(1);
  });
}

for (const reason of ['cloudflare', 'rate-limit', 'fetch-timeout']) {
  test(`entrypoint preserves bounded ${reason} stop with pending articles`, async () => {
    const result = await runScenario(reason);
    expect(result.code).toBe(0);
    expect(result.report.stopReason).toBe(
      reason === 'fetch-timeout' ? 'network-error' : reason,
    );
    expect(result.report.status).toBe(
      reason === 'fetch-timeout' ? 'partial' : 'blocked',
    );
    expect(result.report.counts).toEqual({
      total: 4,
      processed: 3,
      successful: 1,
      failed: 1,
      notFound: 0,
      skipped: 1,
    });
    expect(result.events.filter((event) => event.startsWith('fetch:'))).toEqual(
      ['fetch:ok', 'fetch:missing'],
    );
    expect(result.marker).toBe(false);
  });
}

for (const reason of ['timeout', 'sigint', 'sigterm']) {
  test(`${reason} publishes partial counts and finalizes exactly once without late writes`, async () => {
    const result = await runScenario(reason);
    expect(result.code).toBe(
      reason === 'sigint' ? 130 : reason === 'sigterm' ? 143 : 0,
    );
    expect(result.report.stopReason).toBe(reason);
    expect(result.report.status).toBe('partial');
    expect(result.report.finalized).toBe(true);
    expect(result.report.counts.successful).toBe(1);
    expect(result.report.counts.failed).toBe(0);
    expect(result.events.filter((event) => event === 'write')).toHaveLength(1);
    expect(
      result.events.filter((event) => event === 'checkpoint'),
    ).toHaveLength(1);
    expect(result.events.filter((event) => event === 'close')).toHaveLength(1);
    expect(result.marker).toBe(false);
  });
}

test('forced timeout leaves accurate unfinished report for workflow recovery', async () => {
  const result = await runScenario('forced-timeout');
  expect(result.code).toBe(1);
  expect(result.report.stopReason).toBe('timeout');
  expect(result.report.finalized).toBe(false);
  expect(result.report.counts.successful).toBe(1);
  expect(result.events).not.toContain('checkpoint');
  expect(result.marker).toBe(false);
});

for (const scenario of [
  'timeout-write-failed',
  'timeout-parse-failed',
  'timeout-sitemap-failed',
]) {
  test(`${scenario} retains a real failure that finishes after cancellation`, async () => {
    const result = await runScenario(scenario);
    expect(result.code).toBe(1);
    expect(result.report.stopReason).toBe('fatal-error');
    expect(result.report.error).toBe('fatal-error');
    expect(result.report.finalized).toBe(true);
    expect(result.report.counts.failed).toBe(
      scenario === 'timeout-sitemap-failed' ? 0 : 1,
    );
    expect(result.marker).toBe(false);
    const guard = Bun.spawn(
      [
        'python3',
        '-c',
        'import json, runpy, sys; guard = runpy.run_path(sys.argv[1]); print(guard["evaluate"](json.loads(sys.argv[2]), "success", "success", "success", "true")["workflow"]["releaseEligible"])',
        resolve('.github/scripts/publish-scrape-outcome.py'),
        JSON.stringify(result.report),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(await guard.exited).toBe(0);
    expect((await new Response(guard.stdout).text()).trim()).toBe('False');
  });
}
