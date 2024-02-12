import { PrismaClient } from '@prisma/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import { scrapeAllIndividualArticles } from './scrape/scrapeAllIndividualArticles';
import { scrapeAllCategories } from './scrape/scrapeAllCategories';
import { getArticlesScraped } from './helpers/getArticlesWithReadingsCount';

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

/**
 * Scrape all categories and readings
 * @returns Total number of articles scraped
 */
async function scrapeAll() {
  const totalArticlesInDB = await prisma.pixivArticle.count();
  console.log(`Loaded existing database with ${totalArticlesInDB} articles.`);
  const initialReadingsCount = await getArticlesScraped();
  console.log(`${initialReadingsCount} articles with readings.`);

  await scrapeAllCategories();
  console.log('Scraping of article summaries complete');
  const totalArticles = await prisma.pixivArticle.count();
  console.log(`Total articles: ${totalArticles}`);

  console.log('Scraping article readings');
  await scrapeAllIndividualArticles();
  console.log('Scraping of article readings complete');
  const totalArticlesWithReading = await getArticlesScraped();
  console.log(`Total articles scraped: ${totalArticlesWithReading}`);
  console.log(
    `Scraped ${totalArticlesWithReading - initialReadingsCount} new articles`,
  );

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
