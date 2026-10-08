import { expect, test } from 'bun:test';
import { resolve } from 'path';

async function scrapeScenario(scenario: string) {
  const root = resolve('.');
  const script = `
    import { mock } from 'bun:test';
    const root = ${JSON.stringify(root)};
    const scenario = ${JSON.stringify(scenario)};
    const controller = new AbortController();
    const events = [];
    mock.module(root + '/src/index.ts', () => ({ prisma: {
      pixivArticle: { deleteMany: async () => ({ count: 0 }) },
      $executeRawUnsafe: async () => {
        events.push('batch');
        if (scenario === 'abort-after-batch') controller.abort();
      },
    }}));
    mock.module(root + '/src/helpers/lastScrapedHandler.ts', () => ({
      getCategoryScraped: async () => '2000-01-01T00:00:00Z',
      updateCategoryScraped: async () => events.push('watermark'),
    }));
    mock.module(root + '/src/fetch/fetchURL.ts', () => ({ fetchURL: async (url) => {
      events.push(url.endsWith('sitemap.xml') ? 'index' : 'part');
      if (url.endsWith('sitemap.xml')) return {
        data: '<sitemapindex><sitemap><loc>https://dic.pixiv.net/sitemap/part/1</loc><lastmod>2026-01-01T00:00:00Z</lastmod></sitemap></sitemapindex>',
      };
      if (scenario === 'invalid-part') return { data: '<html>Upstream error</html>' };
      if (scenario === 'abort-after-fetch') controller.abort();
      return { data: scenario === 'empty-part' ? '<urlset/>'
        : '<urlset><url><loc>https://dic.pixiv.net/a/example</loc><lastmod>2026-01-01T00:00:00Z</lastmod></url></urlset>' };
    }}));
    const { scrapeSitemap } = await import(root + '/src/scrape/scrapeSitemap.ts');
    let failed = false;
    try { await scrapeSitemap(controller.signal); } catch { failed = true; }
    console.log(JSON.stringify({ failed, events }));
  `;
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
  if (code !== 0) throw new Error(stderr);
  return JSON.parse(stdout.trim().split('\n').at(-1)!);
}

for (const scenario of [
  'invalid-part',
  'abort-after-fetch',
  'abort-after-batch',
]) {
  test(`${scenario} never advances the sitemap watermark`, async () => {
    const result = await scrapeScenario(scenario);
    expect(result.failed).toBe(true);
    expect(result.events).not.toContain('watermark');
    expect(
      result.events.filter((event: string) => event === 'batch'),
    ).toHaveLength(scenario === 'abort-after-batch' ? 1 : 0);
  });
}

test('a valid empty sitemap part can advance its watermark', async () => {
  const result = await scrapeScenario('empty-part');
  expect(result.failed).toBe(false);
  expect(result.events).toEqual(['index', 'part', 'watermark']);
});
