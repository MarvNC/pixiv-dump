export const PIXIV_BASE_URL = 'https://dic.pixiv.net/';
export const DATE_MAX_FUTURE = '9999-12-31 23:59:59';
export const DATE_MIN_PAST = '2000-01-01 00:00:00';
export const DEFAULT_LAST_SCRAPED = DATE_MIN_PAST;
export const DEFAULT_OLDEST_SCRAPED = DATE_MAX_FUTURE;
export const OLDEST_SCRAPED_REACHED = 'OLDEST_SCRAPED_REACHED';
export const FETCH_DELAY_MS = 0;
export const SITEMAP_INDEX_URL = `${PIXIV_BASE_URL}sitemap.xml`;
export const SITEMAP_PROGRESS_CATEGORY = 'sitemap';
export const PIXIV_API_BASE_URL = `${PIXIV_BASE_URL}_api`;

// Pixiv's WAF intentionally challenges these three vandalism entries from the sitemap.
export const IGNORED_WAF_TAGS = new Set([
  '..',
  '</title><svg onload=alert();>',
  `'"><script>alert(1)</script>`,
]);
