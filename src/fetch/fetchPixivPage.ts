import { fetchURL } from './fetchURL';
import { PIXIV_BASE_URL } from '../constants';

const pixivPage = (category: string, page: number) =>
  `${PIXIV_BASE_URL}${
    category ? 'category/' + category : ''
  }?json=1&page=${page}`;

async function fetchPixivPage(
  category: string,
  page: number,
): Promise<PixivPageResponse> {
  const url = pixivPage(category, page);
  const response = await fetchURL(url);

  if (!isPixivPageResponse(response.data)) {
    throw new Error('Invalid response type');
  }

  return response.data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPixivPageResponse(data: any): data is PixivPageResponse {
  return (
    data.meta &&
    data.meta.all_count &&
    data.meta.count &&
    data.meta.page &&
    data.articles
  );
}

export default fetchPixivPage;
