import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  createScrapeOutcome,
  finalizeOutcome,
  outcomeExitCode,
  publishOutcome,
  recordArticle,
  updateOutcomeStatus,
} from '../helpers/scrapeOutcome';

function completeOutcome() {
  const outcome = createScrapeOutcome();
  outcome.counts.total = 3;
  recordArticle(outcome, 'successful');
  recordArticle(outcome, 'notFound');
  recordArticle(outcome, 'skipped');
  outcome.stopReason = 'completed';
  outcome.finalized = true;
  outcome.database = { before: 10, after: 9 };
  updateOutcomeStatus(outcome);
  return outcome;
}

test('complete includes benign missing/ignored articles, never failed articles', () => {
  const outcome = completeOutcome();
  expect(outcome.status).toBe('complete');
  outcome.counts.total++;
  recordArticle(outcome, 'failed');
  expect(outcome.status).toBe('partial');
  outcome.stopReason = 'fatal-error';
  expect(outcomeExitCode(outcome)).toBe(1);
});

test('all cleanup steps run and publish even after database and browser failures', async () => {
  const outcome = completeOutcome();
  const events: string[] = [];
  const code = await finalizeOutcome(
    outcome,
    ['checkpoint', 'disconnect', 'close browser'].map((name) => ({
      name,
      run: async () => {
        events.push(name);
        if (name !== 'disconnect') throw new Error('secret URL?token=private');
      },
    })),
    (report) => {
      events.push('publish');
      expect(report.finalized).toBe(true);
      expect(report.status).toBe('partial');
      expect(JSON.stringify(report)).not.toContain('private');
    },
  );
  expect(events).toEqual([
    'checkpoint',
    'disconnect',
    'close browser',
    'publish',
  ]);
  expect(code).toBe(1);
  expect(outcome.stopReason).toBe('cleanup-failed');
});

test('outcome publication failure cannot produce a successful exit', async () => {
  expect(
    await finalizeOutcome(completeOutcome(), [], () => {
      throw new Error('disk full');
    }),
  ).toBe(1);
});

test('atomic publication replaces an earlier report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixiv-outcome-'));
  try {
    const path = join(dir, 'outcome.json');
    publishOutcome(createScrapeOutcome(), path);
    publishOutcome(completeOutcome(), path);
    expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('complete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const guard = resolve('.github/scripts/publish-scrape-outcome.py');
async function workflowReport(
  report: unknown,
  env: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'pixiv-workflow-'));
  try {
    if (report !== undefined) {
      writeFileSync(join(dir, 'scrape-outcome.json'), JSON.stringify(report));
    }
    const child = Bun.spawn(['python3', guard], {
      cwd: dir,
      env: {
        ...process.env,
        SCRAPE_RESULT: 'success',
        CHECKPOINT_RESULT: 'success',
        PREVIOUS_DB_RESULT: 'success',
        BUDGET_ENOUGH: 'true',
        GITHUB_OUTPUT: join(dir, 'outputs'),
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    return {
      report: JSON.parse(
        readFileSync(join(dir, 'scrape-outcome.json'), 'utf8'),
      ),
      summary: readFileSync(join(dir, 'summary'), 'utf8'),
      outputs: readFileSync(join(dir, 'outputs'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('workflow release guard accepts completed useful work and reports counts', async () => {
  const result = await workflowReport(completeOutcome());
  expect(result.outputs).toContain('release_eligible=true');
  expect(result.summary).toContain('Processed: 3/3');
});

for (const kind of [
  'missing',
  'invalid',
  'no-progress',
  'failed',
  'unfinished',
  'checkpoint-failed',
  'process-failed',
  'empty-db',
  'signal',
] as const) {
  test(`workflow release guard rejects ${kind} and still publishes a summary`, async () => {
    const report = completeOutcome();
    if (kind === 'no-progress') {
      report.counts.successful = 0;
      report.counts.skipped++;
    }
    if (kind === 'failed') {
      report.counts.successful = 0;
      report.counts.failed++;
    }
    if (kind === 'unfinished') report.finalized = false;
    if (kind === 'empty-db') report.database.after = 0;
    if (kind === 'signal') report.stopReason = 'sigterm';
    const result = await workflowReport(
      kind === 'missing'
        ? undefined
        : kind === 'invalid'
          ? { counts: null }
          : report,
      kind === 'checkpoint-failed'
        ? { CHECKPOINT_RESULT: 'failure' }
        : kind === 'process-failed'
          ? { SCRAPE_RESULT: 'failure' }
          : {},
    );
    expect(result.outputs).toContain('release_eligible=false');
    expect(result.summary).toContain('Release eligible: **false**');
  });
}

test('a clean timed partial scrape can release useful work, never an unfinished one', async () => {
  const report = completeOutcome();
  report.counts.total += 10;
  report.status = 'partial';
  report.stopReason = 'timeout';
  expect((await workflowReport(report)).outputs).toContain(
    'release_eligible=true',
  );
  report.finalized = false;
  expect((await workflowReport(report)).outputs).toContain(
    'release_eligible=false',
  );
});

test('skipped run gets an explicit budget/setup reason with no report', async () => {
  expect(
    (
      await workflowReport(undefined, {
        SCRAPE_RESULT: 'skipped',
        BUDGET_ENOUGH: 'false',
      })
    ).report.stopReason,
  ).toBe('insufficient-budget');
  expect(
    (
      await workflowReport(undefined, {
        SCRAPE_RESULT: 'skipped',
        BUDGET_ENOUGH: '',
      })
    ).report.stopReason,
  ).toBe('setup-failed');
});

for (const kind of [
  'missing-db-fields',
  'contradictory-status',
  'fatal-then-timeout',
] as const) {
  test(`malformed ${kind} is fail-closed without losing workflow summary`, async () => {
    const report = completeOutcome();
    const invalid =
      kind === 'missing-db-fields'
        ? { ...report, database: {} }
        : kind === 'contradictory-status'
          ? { ...report, stopReason: 'fatal-error' }
          : {
              ...report,
              status: 'partial',
              stopReason: 'timeout',
              error: 'fatal-error',
            };
    const result = await workflowReport(invalid);
    expect(result.outputs).toContain('release_eligible=false');
    expect(result.summary).toContain('Scrape outcome:');
  });
}

for (const invalid of [
  null,
  [],
  'invalid',
  { stopReason: [] },
  { stopReason: {} },
  { counts: [] },
  { database: [] },
]) {
  test(`malformed scalar/collection report publishes a fallback: ${JSON.stringify(invalid)}`, async () => {
    const result = await workflowReport(
      invalid && typeof invalid === 'object' && !Array.isArray(invalid)
        ? { ...completeOutcome(), ...invalid }
        : invalid,
    );
    expect(result.report.workflow.reportValid).toBe(false);
    expect(result.outputs).toContain('release_eligible=false');
  });
}

test('a late timeout cannot hide a previously recorded fatal error', () => {
  const outcome = completeOutcome();
  outcome.error = 'fatal-error';
  outcome.stopReason = 'timeout';
  expect(outcomeExitCode(outcome)).toBe(1);
});
