import fs from 'fs';

export type StopReason =
  | 'running'
  | 'completed'
  | 'cloudflare'
  | 'rate-limit'
  | 'network-error'
  | 'fatal-error'
  | 'timeout'
  | 'sigint'
  | 'sigterm'
  | 'cleanup-failed';

export type ScrapeOutcome = {
  schemaVersion: 1;
  status: 'complete' | 'partial' | 'blocked';
  stopReason: StopReason;
  phase: 'starting' | 'sitemap' | 'articles' | 'finalizing';
  finalized: boolean;
  stoppedPhase?: ScrapeOutcome['phase'];
  startedAt: string;
  finishedAt: string | null;
  counts: {
    total: number;
    processed: number;
    successful: number;
    failed: number;
    notFound: number;
    skipped: number;
  };
  database: { before: number | null; after: number | null };
  error?: string;
  cleanupErrors: string[];
};

export function createScrapeOutcome(): ScrapeOutcome {
  return {
    schemaVersion: 1,
    status: 'partial',
    stopReason: 'running',
    phase: 'starting',
    finalized: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    counts: {
      total: 0,
      processed: 0,
      successful: 0,
      failed: 0,
      notFound: 0,
      skipped: 0,
    },
    database: { before: null, after: null },
    cleanupErrors: [],
  };
}

export function updateOutcomeStatus(outcome: ScrapeOutcome): void {
  outcome.status =
    outcome.stopReason === 'completed' &&
    outcome.counts.failed === 0 &&
    outcome.counts.processed === outcome.counts.total &&
    outcome.cleanupErrors.length === 0
      ? 'complete'
      : outcome.stopReason === 'cloudflare' ||
          outcome.stopReason === 'rate-limit'
        ? 'blocked'
        : 'partial';
}

export function recordArticle(
  outcome: ScrapeOutcome,
  result: 'successful' | 'failed' | 'notFound' | 'skipped',
  count = 1,
): void {
  outcome.counts[result] += count;
  outcome.counts.processed += count;
  updateOutcomeStatus(outcome);
}

export function publishOutcome(
  outcome: ScrapeOutcome,
  path = 'scrape-outcome.json',
): void {
  updateOutcomeStatus(outcome);
  // Readers see either the previous complete snapshot or the next one.
  fs.writeFileSync(`${path}.tmp`, `${JSON.stringify(outcome, null, 2)}\n`);
  fs.renameSync(`${path}.tmp`, path);
}

export function outcomeExitCode(outcome: ScrapeOutcome): number {
  if (outcome.stopReason === 'sigint') return 130;
  if (outcome.stopReason === 'sigterm') return 143;
  return outcome.error === 'fatal-error' ||
    outcome.stopReason === 'fatal-error' ||
    outcome.stopReason === 'cleanup-failed' ||
    outcome.cleanupErrors.length > 0
    ? 1
    : 0;
}

/** Run every cleanup, then publish, even if an earlier cleanup failed. */
export async function finalizeOutcome(
  outcome: ScrapeOutcome,
  cleanups: Array<{ name: string; run: () => Promise<unknown> }>,
  publish: (outcome: ScrapeOutcome) => void = publishOutcome,
): Promise<number> {
  outcome.stoppedPhase = outcome.phase;
  outcome.phase = 'finalizing';
  for (const cleanup of cleanups) {
    try {
      await cleanup.run();
    } catch {
      outcome.cleanupErrors.push(`${cleanup.name} failed`);
    }
  }
  if (outcome.cleanupErrors.length > 0) {
    // Preserve the original fatal/interrupt reason for diagnosis.
    if (outcome.stopReason === 'completed') {
      outcome.stopReason = 'cleanup-failed';
    }
  }
  outcome.finalized = true;
  outcome.finishedAt = new Date().toISOString();
  updateOutcomeStatus(outcome);
  try {
    publish(outcome);
  } catch {
    console.error('Failed to publish scrape outcome');
    return 1;
  }
  return outcomeExitCode(outcome);
}
