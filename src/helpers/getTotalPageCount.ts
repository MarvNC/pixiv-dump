import { LIST_OFFSET_LIMIT } from '../constants';
import fetchPixivPage from '../fetch/fetchPixivPage';

export async function getTotalPageCount(category: string) {
  const firstPageData = await fetchPixivPage(category, 1);
  const pageSize = firstPageData.meta.count;
  const totalPageCount = Math.ceil(firstPageData.meta.all_count / pageSize);
  const maxReachablePage = Math.floor(LIST_OFFSET_LIMIT / pageSize);
  return Math.min(totalPageCount, maxReachablePage);
}
