import { PrismaClient } from '@prisma/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
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
      exitHandler();
      process.exit(0);
    }, timeout);
  }

  scrapeAll()
    .then(async (totalArticles) => {
      exitHandler({
        completedScraping: true,
        totalArticles,
      });
    })
    .catch(async (e) => {
      console.error(e);
      exitHandler({ code: 1 });
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

  return totalArticles;
}

process.on('SIGINT', async () => {
  console.log(
    'Received SIGINT signal. Disconnecting Prisma and exiting program',
  );
  exitHandler();
});

/**
 * Disconnect Prisma and exit the program
 * @param code Exit code
 */
function exitHandler({
  code = 0,
  completedScraping = false,
  totalArticles = 0,
}: {
  code?: number;
  completedScraping?: boolean;
  totalArticles?: number;
} = {}) {
  console.log('Exiting program');
  prisma.$disconnect();
  if (completedScraping) {
    console.log(`Scraped ${totalArticles} articles`);
    // Write to total.txt
    fs.writeFileSync('total.txt', totalArticles.toString());
  }
  process.exit(code);
}
