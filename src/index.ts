import { PrismaClient } from '@prisma/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { PIXIV_CATEGORIES } from './constants';
import { getCategoryLastScraped } from './helpers/lastScrapedHandler';
import { scrapePixivCategory } from './scrape/scrapePixivCategory';
import { scrapeAllReadings } from './scrapeAllReadings';

export const prisma = new PrismaClient();

(async () => {
  const argv = yargs(hideBin(process.argv)).option('timeout', {
    describe: 'Exit program after a specified amount of time (in milliseconds)',
    type: 'number',
  }).argv;

  const { timeout } = argv as { timeout: number };

  if (timeout) {
    console.log(`Timeout set to ${timeout} milliseconds`);
    setTimeout(async () => {
      console.log('Timeout reached. Exiting program');
      await prisma.$disconnect();
      process.exit(0);
    }, timeout);
  }

  scrapeAll()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
})();

async function scrapeAll() {
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
}

process.on('SIGINT', async () => {
  console.log(
    'Received SIGINT signal. Disconnecting Prisma and exiting program',
  );
  await prisma.$disconnect();
  process.exit(0);
});
