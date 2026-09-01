import cliProgress from 'cli-progress';
import { prisma } from '..';
import { IGNORED_WAF_TAGS } from '../constants';
import { CloudflareError, HttpError } from '../fetch/errors';
import {
  scrapeSingleArticleInfo,
  ArticleNotFoundError,
} from './scrapeSingleArticleInfo';

const CF_GIVE_UP_STREAK = 5;
const RATE_LIMIT_GIVE_UP_STREAK = 5;

/**
 * Scrape all readings for articles that have not been scraped yet or have been updated since the last scrape.
 */
export async function scrapeAllIndividualArticles(): Promise<boolean> {
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

  const isNotIgnoredWafTag = ({ tag_name }: { tag_name: string }) =>
    !IGNORED_WAF_TAGS.has(tag_name);
  const newlyNeverScraped = newlyNeverScrapedRows.filter(isNotIgnoredWafTag);
  const updatedArticles = updatedArticleRows.filter(isNotIgnoredWafTag);

  const articles = [...newlyNeverScraped, ...updatedArticles];

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
  let cfStreak = 0;
  let rateLimitStreak = 0;
  let completed = true;
  while (progressBarIndex < articles.length) {
    const { tag_name } = articles[progressBarIndex];
    try {
      const scraped = await scrapeSingleArticleInfo(tag_name);
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
      cfStreak = 0;
      rateLimitStreak = 0;
    } catch (error) {
      if (error instanceof ArticleNotFoundError) {
        console.log(`Article not found, removing from database: ${tag_name}`);
        await prisma.pixivArticle.delete({
          where: { tag_name },
        });
        cfStreak = 0;
      } else if (error instanceof HttpError && error.status === 429) {
        rateLimitStreak++;
        if (rateLimitStreak < RATE_LIMIT_GIVE_UP_STREAK) {
          const waitMs = 20_000 * rateLimitStreak;
          console.log(
            `HTTP 429 on ${tag_name}, waiting ${waitMs}ms (streak ${rateLimitStreak})`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        console.error(
          `Still rate limited after ${rateLimitStreak} tries, skipping ${tag_name}`,
        );
        rateLimitStreak = 0;
      } else if (error instanceof CloudflareError) {
        cfStreak++;
        if (cfStreak >= CF_GIVE_UP_STREAK) {
          console.error(
            `Cloudflare still blocking after ${cfStreak} articles, stopping article scrape`,
          );
          completed = false;
          break;
        }
        const waitMs = 10_000;
        console.log(
          `Cloudflare blocking ${tag_name}, waiting ${waitMs}ms (streak ${cfStreak})`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      } else {
        console.error(`Error scraping article ${tag_name}: ${error}`);
      }
    }
    progressBarIndex++;
    if (showBar) {
      progressBar.update(progressBarIndex);
    }
    if (progressBarIndex % 10 === 0) {
      console.log(`Processed ${progressBarIndex}/${articles.length} articles`);
    }
    if (progressBarIndex === newlyNeverScraped.length) {
      console.log(`All newly added articles processed`);
    }
  }
  if (showBar) {
    progressBar.stop();
  }
  return completed;
}
