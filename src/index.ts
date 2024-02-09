import { PrismaClient } from '@prisma/client';
import { PIXIV_CATEGORIES } from './constants';
import { getCategoryLastScraped } from './helpers/lastScrapedHandler';
import { scrapePixivCategory } from './scrape/scrapePixivCategory';
import { scrapeAllReadings } from './scrapeAllReadings';

export const prisma = new PrismaClient();

(async () => {
  for (const category of PIXIV_CATEGORIES) {
    const newestScrapedDate = await getCategoryLastScraped(category);
    console.log(`Scraping ${category} from ${newestScrapedDate}`);
    await scrapePixivCategory(category, newestScrapedDate);
  }
  console.log('Scraping of article summaries complete');
  const totalArticles = await prisma.pixivArticle.count();
  console.log(`Total articles: ${totalArticles}`);

  await scrapeAllReadings();
  console.log('Scraping of article readings complete');
  const totalArticlesWithReading = await prisma.pixivArticle.count({
    where: { lastScrapedReading: { not: null } },
  });
  console.log(`Total articles scraped: ${totalArticlesWithReading}`);
})()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
