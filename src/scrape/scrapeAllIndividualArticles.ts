import cliProgress from 'cli-progress';
import { prisma } from '..';
import { IGNORED_WAF_TAGS } from '../constants';
import {
  CloudflareError,
  FetchTimeoutError,
  HttpError,
  isTransientFetchError,
} from '../fetch/errors';
import {
  recordArticle,
  type ScrapeOutcome,
  type StopReason,
} from '../helpers/scrapeOutcome';
import {
  scrapeSingleArticleInfo,
  ArticleNotFoundError,
} from './scrapeSingleArticleInfo';

export function failureStopReason(error: unknown): StopReason {
  if (error instanceof CloudflareError) return 'cloudflare';
  if (error instanceof HttpError && error.status === 429) return 'rate-limit';
  if (error instanceof FetchTimeoutError || isTransientFetchError(error))
    return 'network-error';
  return 'fatal-error';
}

/**
 * Scrape all readings for articles that have not been scraped yet or have been updated since the last scrape.
 */
export async function scrapeAllIndividualArticles(
  outcome: ScrapeOutcome,
  signal: AbortSignal,
  onProgress: () => void = () => undefined,
): Promise<void> {
  signal.throwIfAborted();
  // Find articles that need individual scraping:
  // 1. Articles never scraped individually (lastScrapedArticle IS NULL) - prioritized first
  // 2. Articles updated since last individual scrape (lastScraped > lastScrapedArticle)
  // We need to use queryRaw because these fields are saved as strings of numbers.

  // Newly never-scraped articles (lastScrapedArticle IS NULL)
  const newlyNeverScrapedRows = await prisma.$queryRaw<
    Array<{ tag_name: string }>
  >`
    SELECT tag_name
    FROM PixivArticle
    WHERE lastScrapedArticle IS NULL
    ORDER BY CAST(lastScraped as INTEGER) ASC
  `;

  // Updated articles (lastScrapedArticle IS NOT NULL and lastScraped > lastScrapedArticle)
  const updatedArticleRows = await prisma.$queryRaw<
    Array<{ tag_name: string }>
  >`
    SELECT tag_name
    FROM PixivArticle
    WHERE lastScrapedArticle IS NOT NULL
      AND lastScraped IS NOT NULL
      AND lastScraped GLOB '[0-9]*'
      AND lastScrapedArticle GLOB '[0-9]*'
      AND CAST(lastScraped AS INTEGER) > CAST(lastScrapedArticle AS INTEGER)
    ORDER BY CAST(lastScraped AS INTEGER) ASC,
             tag_name
  `;

  signal.throwIfAborted();
  const isNotIgnoredWafTag = ({ tag_name }: { tag_name: string }) =>
    !IGNORED_WAF_TAGS.has(tag_name);
  const newlyNeverScraped = newlyNeverScrapedRows.filter(isNotIgnoredWafTag);
  const updatedArticles = updatedArticleRows.filter(isNotIgnoredWafTag);

  const articles = [...newlyNeverScraped, ...updatedArticles];
  outcome.counts.total =
    newlyNeverScrapedRows.length + updatedArticleRows.length;
  recordArticle(outcome, 'skipped', outcome.counts.total - articles.length);
  onProgress();

  console.log(
    `Scraping ${articles.length} individual articles (${newlyNeverScraped.length} newly added, ${updatedArticles.length} updated)`,
  );

  const showBar = Boolean(process.stdout.isTTY);
  const progressBar = new cliProgress.SingleBar(
    {
      format:
        'Progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} Articles',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );
  if (showBar) {
    progressBar.start(articles.length, 0);
  }

  let progressBarIndex = 0;
  try {
    while (progressBarIndex < articles.length) {
      signal.throwIfAborted();
      const { tag_name } = articles[progressBarIndex];
      try {
        const scraped = await scrapeSingleArticleInfo(tag_name);
        signal.throwIfAborted();
        await prisma.pixivArticle.update({
          where: { tag_name },
          data: {
            lastScrapedArticle: Date.now().toString(),
            reading: scraped.reading,
            header: JSON.stringify(scraped.header),
            mainText: scraped.mainText,
            summary: scraped.summary,
            parent: scraped.parent,
            related_tags: JSON.stringify(scraped.related_tags),
            main_illst_url: scraped.main_illst_url,
            ...(scraped.view_count !== undefined
              ? { view_count: scraped.view_count }
              : {}),
            ...(scraped.illust_count !== undefined
              ? { illust_count: scraped.illust_count }
              : {}),
            ...(scraped.check_count !== undefined
              ? { check_count: scraped.check_count }
              : {}),
            ...(scraped.updated_at ? { updated_at: scraped.updated_at } : {}),
          },
        });
        recordArticle(outcome, 'successful');
      } catch (error) {
        // Cancellation must not hide an independent parser/database failure that
        // finished after the timeout. Only our exact abort reason is benign.
        if (signal.aborted && error === signal.reason) throw error;
        if (error instanceof ArticleNotFoundError) {
          signal.throwIfAborted();
          console.log(`Article not found, removing from database: ${tag_name}`);
          try {
            await prisma.pixivArticle.delete({ where: { tag_name } });
            recordArticle(outcome, 'notFound');
          } catch (deleteError) {
            recordArticle(outcome, 'failed');
            throw deleteError;
          }
        } else {
          // Fetch already exhausted its bounded retries. Do not multiply them here.
          recordArticle(outcome, 'failed');
          outcome.stopReason = failureStopReason(error);
          outcome.error = outcome.stopReason;
          console.error(`Article scrape stopped: ${outcome.stopReason}`);
          onProgress();
          return;
        }
      }
      onProgress();
      progressBarIndex++;
      if (showBar) {
        progressBar.update(progressBarIndex);
      }
      if (progressBarIndex % 10 === 0) {
        console.log(
          `Processed ${progressBarIndex}/${articles.length} articles`,
        );
      }
      if (progressBarIndex === newlyNeverScraped.length) {
        console.log(`All newly added articles processed`);
      }
    }
    signal.throwIfAborted();
    outcome.stopReason = 'completed';
    onProgress();
  } finally {
    if (showBar) progressBar.stop();
  }
}
