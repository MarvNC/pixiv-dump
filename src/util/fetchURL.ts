import axios, { AxiosResponse } from 'axios';
import axiosRetry from 'axios-retry';

export async function fetchURL(url: string): Promise<AxiosResponse> {
  axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });
  const response = await axios.get(url);
  return response;
}
