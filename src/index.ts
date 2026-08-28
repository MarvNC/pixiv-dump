import { PrismaClient } from '@prisma/client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import { scrapeAllIndividualArticles } from './scrape/scrapeAllIndividualArticles';
import { scrapeSitemap } from './scrape/scrapeSitemap';
import { getArticlesScrapedCount } from './helpers/getArticlesWithReadingsCount';
import { closeSession } from './fetch/fetchURL';

export const prisma = new PrismaClient();

(async () => {
  const argv = yargs(hideBin(process.argv)).option('timeout', {
    describe: 'Exit program after a specified amount of time (in milliseconds)',
    type: 'number',
  }).argv;

  const { timeout } = argv as { timeout: number };

  if (timeout) {
    console.log(`Timeout set to ${timeout} milliseconds`);
    setTimeout(() => {
      console.log('Timeout reached. Exiting program');
      void exitHandler();
    }, timeout);
  }

  scrapeAll()
    .then(async (totalArticles) => {
      await exitHandler({
        completedScraping: true,
        totalArticles,
      });
    })
    .catch(async (e) => {
      console.error(e);
      await exitHandler({ code: 1 });
    });
})();

/**
 * Scrape all categories and readings
 * @returns Total number of articles scraped
 */
async function scrapeAll() {
  const totalArticlesInDB = await prisma.pixivArticle.count();
  console.log(`Loaded existing database with ${totalArticlesInDB} articles.`);
  const initialReadingsCount = await getArticlesScrapedCount();
  console.log(`${initialReadingsCount} articles with readings.`);

  console.log('Scraping sitemap');
  await scrapeSitemap();
  console.log('Scraping of sitemap complete');
  const totalArticles = await prisma.pixivArticle.count();
  console.log(`Total articles: ${totalArticles}`);

  console.log('Scraping single articles');
  await scrapeAllIndividualArticles();
  console.log('Scraping of articles complete!');
  const individualArticlesScraped = await getArticlesScrapedCount();
  console.log(`Total articles scraped: ${individualArticlesScraped}`);
  console.log(
    `Scraped ${individualArticlesScraped - initialReadingsCount} new articles`,
  );

  return totalArticles;
}

process.on('SIGINT', () => {
  console.log(
    'Received SIGINT signal. Disconnecting Prisma and exiting program',
  );
  void exitHandler();
});

process.on('SIGTERM', () => {
  console.log(
    'Received SIGTERM signal. Disconnecting Prisma and exiting program',
  );
  void exitHandler();
});

async function exitHandler({
  code = 0,
  completedScraping = false,
  totalArticles = 0,
}: {
  code?: number;
  completedScraping?: boolean;
  totalArticles?: number;
} = {}) {
  console.log('Exiting program');
  try {
    await prisma.$disconnect();
  } catch (error) {
    console.error(error);
  }
  await closeSession();
  if (completedScraping) {
    console.log(`Scraped ${totalArticles} articles`);
    fs.writeFileSync('total.txt', totalArticles.toString());
  }
  process.exit(code);
}
