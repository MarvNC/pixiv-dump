import axios from 'axios';
import axiosRetry from 'axios-retry';

const pixivBaseURL = 'https://dic.pixiv.net/';
const pixivPage = (category: string, page: number) =>
  `${pixivBaseURL}${category ? 'category/' + category : ''}?json=1&page=${page}`;

async function fetchPixivPage(category: string, page: number) {
  axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });
  const url = pixivPage(category, page);
  const response = await axios.get(url);
  return response.data;
}

export default fetchPixivPage;
