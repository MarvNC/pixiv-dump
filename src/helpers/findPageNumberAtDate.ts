import fetchPixivPage from '../fetch/fetchPixivPage';

/**
 * Finds the page number in a category to start scraping
 * from based on the last scraped date.
 * Binary search to find the page number.
 */
export async function findPageNumberAtDate(category: string, lastScraped: string) {
  const firstPageData = await fetchPixivPage(category, 1);
  const totalPageCount = Math.ceil(
    firstPageData.meta.all_count / firstPageData.meta.count
  );
  let left = 1;
  let right = totalPageCount;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const midPageData = await fetchPixivPage(category, mid);
    const midPageDate = new Date(midPageData.articles[0].updated_at);
    if (midPageDate < new Date(lastScraped)) {
      right = mid;
    } else {
      left = mid + 1;
    }
    console.log(
      `Searching for ${lastScraped} in ${category}: ${left} ${right}`
    );
  }
  return Math.max(left, right);
}
