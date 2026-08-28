export const PIXIV_BASE_URL = 'https://dic.pixiv.net/';
export const PIXIV_CATEGORIES = [
  'アニメ',
  'マンガ',
  'ラノベ',
  'ゲーム',
  'フィギュア',
  '音楽',
  'アート',
  'デザイン',
  '一般',
  '人物',
  'キャラクター',
  'セリフ',
  'イベント',
  '同人サークル',
];
export const DATE_MAX_FUTURE = '9999-12-31 23:59:59';
export const DATE_MIN_PAST = '2000-01-01 00:00:00';
export const DEFAULT_LAST_SCRAPED = DATE_MIN_PAST;
export const DEFAULT_OLDEST_SCRAPED = DATE_MAX_FUTURE;
export const OLDEST_SCRAPED_REACHED = 'OLDEST_SCRAPED_REACHED';
export const FETCH_DELAY_MS = 0;
export const LIST_OFFSET_LIMIT = 10000;
export const SITEMAP_INDEX_URL = `${PIXIV_BASE_URL}sitemap.xml`;
export const SITEMAP_PROGRESS_CATEGORY = 'sitemap';
export const PIXIV_API_BASE_URL = `${PIXIV_BASE_URL}_api`;
