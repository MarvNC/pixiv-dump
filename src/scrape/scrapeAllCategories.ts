import {
  DATE_MAX_FUTURE,
  DATE_MIN_PAST,
  OLDEST_SCRAPED_REACHED,
  PIXIV_CATEGORIES,
} from '../constants';
import { findPageNumberAtDate } from '../helpers/findPageNumberAtDate';
import { scrapeArticleList } from './scrapeArticleList';
import {
  getCategoryScraped,
  updateCategoryScraped,
} from '../helpers/lastScrapedHandler';
import { getTotalPageCount } from '../helpers/getTotalPageCount';

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
  const totalPageCount = await getTotalPageCount(category);
  // Scrape to newestScrape
  const newestScrapeDate = await getCategoryScraped({
    category,
    sort: 'newest',
  });
  console.log(
    `${category}: Newest scrape: ${newestScrapeDate}, Total pages: ${totalPageCount}`,
  );

  let lastLoopScrapeDate = DATE_MAX_FUTURE;
  let pageNumber = 1;
  let firstArticleDate = '';
  // If it's the default value then it's the initial scrape and we don't need to update, so we skip
  // While we are scraping pages that are newer than newestScrapeDate, continue scraping
  while (
    newestScrapeDate !== DATE_MIN_PAST &&
    new Date(lastLoopScrapeDate) > new Date(newestScrapeDate)
  ) {
    const { date: responseDate } = await scrapeArticleList(
      category,
      pageNumber,
    );
    if (pageNumber === 1) {
      firstArticleDate = responseDate;
    }
    lastLoopScrapeDate = responseDate;
    if (!lastLoopScrapeDate) {
      break;
    }
    console.log(
      `${category}: Updates: ${lastLoopScrapeDate} Page: ${pageNumber}/${totalPageCount}`,
    );
    pageNumber++;
    updateCategoryScraped({
      category,
      date: lastLoopScrapeDate,
      sort: 'oldest',
    });
  }
  // Once done, we update the newestScrapeDate to the very first article we scraped
  // We don't update it before/during the loop because if the program is interrupted and we haven't reached the previous newestScrapeDate, there would be an unscraped hole.
  if (!firstArticleDate) {
    firstArticleDate = (await scrapeArticleList(category, 1)).date;
  }
  await updateCategoryScraped({
    category,
    date: firstArticleDate,
    sort: 'newest',
  });

  const oldestScrapeDate = await getCategoryScraped({
    category,
    sort: 'oldest',
  });
  console.log(`${category}: Oldest scrape date: ${oldestScrapeDate}`);

  // If the oldestScrapeDate is OLDEST_SCRAPED_REACHED, we don't need to scrape any further
  if (oldestScrapeDate === OLDEST_SCRAPED_REACHED) {
    console.log(`${category}: Scrape complete`);
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
    const { count: resultCount, date: resultDate } = await scrapeArticleList(
      category,
      pageNumber,
    );
    count = resultCount;
    console.log(
      `${category}: Scraping back: ${resultDate} Page: ${pageNumber}/${totalPageCount}`,
    );
    pageNumber++;
    updateCategoryScraped({
      category,
      date: resultDate,
      sort: 'oldest',
    });
  }
  updateCategoryScraped({
    category,
    date: OLDEST_SCRAPED_REACHED,
    sort: 'oldest',
  });

  console.log(`${category}: Scrape complete`);
}
