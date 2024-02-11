// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isPixivPageResponse(data: any): data is PixivPageResponse {
  return (
    data.meta &&
    data.meta.all_count &&
    data.meta.count &&
    data.meta.page &&
    Array.isArray(data.articles)
  );
}
