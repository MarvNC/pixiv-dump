import { fetchURL } from './fetchURL';
import { PIXIV_BASE_URL } from '../constants';
import { isPixivPageResponse } from './isPixivPageResponse';

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

export default fetchPixivPage;
