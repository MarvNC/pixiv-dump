import { PrismaClient } from '@prisma/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import { scrapeAllIndividualArticles } from './scrape/scrapeAllIndividualArticles';
import { scrapeSitemap } from './scrape/scrapeSitemap';
import { closeSession } from './fetch/fetchURL';
import { failureStopReason } from './scrape/scrapeAllIndividualArticles';
import {
  createScrapeOutcome,
  finalizeOutcome,
  publishOutcome,
  type StopReason,
} from './helpers/scrapeOutcome';

export const prisma = new PrismaClient();

export async function main() {
  const outcome = createScrapeOutcome();
  const controller = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => publishOutcome(outcome);
  const stop = (reason: StopReason) => {
    if (controller.signal.aborted) return;
    outcome.stopReason = reason;
    controller.abort(new Error(`Scrape stopped: ${reason}`));
    publish();
    // A stuck browser/driver must not prevent the runner's backup/summary steps.
    // An unfinished report is never release eligible. No concurrent finalizer.
    forceExitTimer = setTimeout(() => {
      console.error('Shutdown grace expired; preserving unfinished outcome');
      publish();
      process.exit(reason === 'sigint' ? 130 : reason === 'sigterm' ? 143 : 1);
    }, 30_000);
  };
  const onSigint = () => stop('sigint');
  const onSigterm = () => stop('sigterm');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    // Do not let an old completion marker survive a failed or partial run.
    fs.rmSync('total.txt', { force: true });
    publish();
    const argv = await yargs(hideBin(process.argv))
      .option('timeout', {
        describe: 'Stop scraping after this many milliseconds',
        type: 'number',
      })
      .exitProcess(false)
      .parse();
    const { timeout } = argv;
    if (timeout !== undefined) {
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new Error('--timeout must be a positive finite number');
      }
      timeoutTimer = setTimeout(() => stop('timeout'), timeout);
    }

    outcome.database.before = await prisma.pixivArticle.count();
    outcome.phase = 'sitemap';
    publish();
    await scrapeSitemap(controller.signal);
    controller.signal.throwIfAborted();
    outcome.phase = 'articles';
    publish();
    await scrapeAllIndividualArticles(outcome, controller.signal, publish);
  } catch (error) {
    if (!controller.signal.aborted || error !== controller.signal.reason) {
      outcome.stopReason = failureStopReason(error);
      outcome.error = outcome.stopReason;
      console.error(`Scrape failed: ${outcome.stopReason}`);
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    // Keep signal handlers active until cleanup/publication finishes.
    if (!forceExitTimer) {
      forceExitTimer = setTimeout(() => {
        outcome.finalized = false;
        if (outcome.stopReason === 'completed') {
          outcome.stopReason = 'cleanup-failed';
        }
        outcome.cleanupErrors.push('Finalization exceeded 30 seconds');
        publish();
        process.exit(1);
      }, 30_000);
    }
    const code = await finalizeOutcome(outcome, [
      {
        name: 'database count',
        run: async () => {
          outcome.database.after = await prisma.pixivArticle.count();
        },
      },
      {
        name: 'SQLite checkpoint',
        run: () => prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)'),
      },
      { name: 'Prisma disconnect', run: () => prisma.$disconnect() },
      { name: 'fetch session close', run: closeSession },
    ]);
    clearTimeout(forceExitTimer);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (
      outcome.status === 'complete' &&
      outcome.finalized &&
      code === 0 &&
      outcome.database.after !== null
    ) {
      fs.writeFileSync('total.txt', String(outcome.database.after));
    }
    console.log(JSON.stringify(outcome));
    process.exit(code);
  }
}

// Importing Prisma in tests/helpers must not start a live scrape.
if (import.meta.main) {
  main().catch(() => {
    console.error('Scraper entrypoint failed');
    process.exit(1);
  });
}
