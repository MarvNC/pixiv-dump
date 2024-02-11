import fetchPixivPage from '../fetch/fetchPixivPage';

export async function getTotalPageCount(category: string) {
  const firstPageData = await fetchPixivPage(category, 1);
  const totalPageCount = Math.ceil(
    firstPageData.meta.all_count / firstPageData.meta.count,
  );
  return totalPageCount;
}
