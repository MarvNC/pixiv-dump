import fetchPixivPage from './fetch/fetchPixivPage';
import { PixivArticle, PrismaClient } from '@prisma/client';
import { PIXIV_CATEGORIES } from './constants';
import { getCategoryLastScraped } from './helpers/getCategoryLastScraped';

export const prisma = new PrismaClient();

(async () => {
  for (const category of PIXIV_CATEGORIES) {
    const newestScrapedDate = await getCategoryLastScraped(category);
    console.log(`Scraping ${category} from ${newestScrapedDate}`);
    await scrapePixivCategory(category, newestScrapedDate);
  }
  // const data = await fetchPixivPage('', 1);
  // for (const article of data.articles) {
  //   await prisma.pixivArticle.upsert({
  //     where: { tag_name: article.tag_name },
  //     update: convertToPixivArticle(article),
  //     create: convertToPixivArticle(article),
  //   });
  // }

  // const articles = await prisma.pixivArticle.findMany();
  // console.log(articles);
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
}

/**
 * Finds the page number in a category to start scraping
 * from based on the last scraped date.
 * Binary search to find the page number.
 */
async function findPageNumberAtDate(category: string, lastScraped: string) {
  const firstPageData = await fetchPixivPage(category, 1);
  const totalPageCount = Math.ceil(
    firstPageData.meta.all_count / firstPageData.meta.count,
  );
  let left = 1;
  let right = totalPageCount;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const midPageData = await fetchPixivPage(category, mid);
    const midPageDate = new Date(midPageData.articles[0].updated_at);
    if (midPageDate > new Date(lastScraped)) {
      right = mid;
    } else {
      left = mid + 1;
    }
    console.log(
      `Searching for ${lastScraped} in ${category}: ${left} ${right}`,
    );
  }
  return Math.max(left, right);
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
