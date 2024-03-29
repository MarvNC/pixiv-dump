import fetchPixivPage from '../fetch/fetchPixivPage';
import { getTotalPageCount } from './getTotalPageCount';

/**
 * Finds the page number in a category to start scraping
 * from based on the last scraped date.
 * Binary search to find the page number.
 * Finds the page with a date that is more recent than
 * the last scraped date so it comes earlier in the list.
 */
export async function findPageNumberAtDate(
  category: string,
  dateToFind: string,
) {
  const totalPageCount = await getTotalPageCount(category);
  let left = 1;
  let right = totalPageCount;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const midPageData = await fetchPixivPage(category, mid);
    const midPageDate = new Date(midPageData.articles[0].updated_at);
    if (midPageDate < new Date(dateToFind)) {
      right = mid;
    } else {
      left = mid + 1;
    }
    console.log(`Searching for ${dateToFind} in ${category}: ${left} ${right}`);
  }
  const pageNum = Math.max(left - 1, 1);
  const pageData = await fetchPixivPage(category, pageNum);
  console.log(
    `Found ${dateToFind} in ${category} at page ${pageNum} with date ${new Date(
      pageData.articles[0].updated_at,
    )}`,
  );
  return pageNum;
}
