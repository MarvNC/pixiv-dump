import { DATE_MAX_FUTURE, PIXIV_CATEGORIES } from '../constants';
import { findPageNumberAtDate } from '../helpers/findPageNumberAtDate';
import { scrapeArticleList } from './scrapeArticleList';
import { getCategoryScraped } from '../helpers/lastScrapedHandler';

export async function scrapeAllCategories() {
  for (const category of PIXIV_CATEGORIES) {
    await scrapePixivCategory(category);
  }
}

/**
 * Scrape forwards from page 1 until newestScrape reached
 * If oldestScrape < newestScrape
 * Binary search for oldestScrape
 * Search onwards from oldestScrape until the end
 * @param category
 */
async function scrapePixivCategory(category: string) {
  // Scrape to newestScrape
  const newestScrapeDate = await getCategoryScraped({
    category,
    sort: 'newest',
  });
  console.log(`${category}: Newest scrape date: ${newestScrapeDate}`);

  let lastLoopScrapeDate = DATE_MAX_FUTURE;
  let pageNumber = 1;
  // While we are scraping pages that are newer than newestScrapeDate, continue scraping
  while (new Date(lastLoopScrapeDate) > new Date(newestScrapeDate)) {
    const result = await scrapeArticleList(category, pageNumber);
    lastLoopScrapeDate = result.date;
    if (!lastLoopScrapeDate) {
      break;
    }
    console.log(
      `${category}: Scrape date: ${lastLoopScrapeDate} Page: ${pageNumber}`,
    );
    pageNumber++;
  }

  const oldestScrapeDate = await getCategoryScraped({
    category,
    sort: 'oldest',
  });
  console.log(`${category}: Oldest scrape date: ${oldestScrapeDate}`);
  if (new Date(oldestScrapeDate) > new Date(newestScrapeDate)) {
    console.log(
      `${category}: Oldest scrape date is newer than newest scrape date`,
    );
    return;
  }

  // Binary search for oldestScrapeDate
  const oldestScrapePage = await findPageNumberAtDate(
    category,
    oldestScrapeDate,
  );
  console.log(
    `${category}: Oldest scrape date found at page ${oldestScrapePage} with date ${oldestScrapeDate}`,
  );

  // Scrape from oldestScrapePage to the end
  let count = 1;
  pageNumber = oldestScrapePage;
  while (count !== 0) {
    const result = await scrapeArticleList(category, pageNumber);
    count = result.count;
    console.log(
      `${category}: Scrape date: ${result.date} Page: ${pageNumber} Count: ${count}`,
    );
    pageNumber++;
  }

  console.log(`${category}: Scrape complete`);
}
