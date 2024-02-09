import { PixivArticle, PrismaClient } from '@prisma/client';
import cliProgress from 'cli-progress';
import { PIXIV_CATEGORIES } from './constants';
import {
  getCategoryLastScraped,
  updateCategoryLastScraped,
} from './helpers/lastScrapedHandler';
import { findPageNumberAtDate } from './helpers/findPageNumberAtDate';
import fetchPixivPage from './fetch/fetchPixivPage';

export const prisma = new PrismaClient();

(async () => {
  for (const category of PIXIV_CATEGORIES) {
    const newestScrapedDate = await getCategoryLastScraped(category);
    console.log(`Scraping ${category} from ${newestScrapedDate}`);
    await scrapePixivCategory(category, newestScrapedDate);
  }
})()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

async function scrapePixivCategory(category: string, lastScraped: string) {
  const pageNumberToStartAt = await findPageNumberAtDate(category, lastScraped);
  console.log(`${category}:Starting at page ${pageNumberToStartAt}`);
  const progressBar = new cliProgress.SingleBar(
    {
      format:
        'Progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} Pages',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );

  progressBar.start(pageNumberToStartAt, 0);
  for (let i = pageNumberToStartAt; i > 0; i--) {
    await scrapeArticleList(category, i);
    progressBar.update(pageNumberToStartAt - i + 1);
  }

  progressBar.stop();
}

async function scrapeArticleList(category: string, pageNumber: number) {
  const data = await fetchPixivPage(category, pageNumber);
  for (const article of data.articles) {
    await prisma.pixivArticle.upsert({
      where: { tag_name: article.tag_name },
      update: convertToPixivArticle(article),
      create: convertToPixivArticle(article),
    });
  }
  updateCategoryLastScraped(category, data.articles[0].updated_at);
}

/**
 * Converts a raw article object to a PixivArticle object.
 */
function convertToPixivArticle(rawArticle: RawArticle): PixivArticle {
  return {
    tag_name: rawArticle.tag_name,
    summary: rawArticle.summary,
    updated_at: rawArticle.updated_at,
    main_illst_url: rawArticle.main_illst_url,
    view_count: rawArticle.view_count,
    illust_count: rawArticle.illust_count,
    check_count: rawArticle.check_count,
    related_tags: JSON.stringify(rawArticle.related_tags),
    parent: rawArticle.parent,
    lastScraped: Date.now().toString(),
    reading: null,
    header: null,
    lastScrapedReading: null,
  };
}
