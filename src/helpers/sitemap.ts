export type SitemapEntry = {
  loc: string;
  lastmod: string;
};

const ARTICLE_URL_PREFIX = 'https://dic.pixiv.net/a/';
const JA_SITEMAP_PART_PREFIX = 'https://dic.pixiv.net/sitemap/part/';

export function parseSitemapIndex(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const pattern =
    /<sitemap>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/sitemap>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    entries.push({ loc: match[1], lastmod: match[2] });
  }
  return entries;
}

export function parseUrlset(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const pattern = /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    entries.push({ loc: match[1], lastmod: match[2] });
  }
  return entries;
}

export function isJapaneseSitemapPart(loc: string): boolean {
  return loc.startsWith(JA_SITEMAP_PART_PREFIX);
}

export function tagNameFromArticleUrl(loc: string): string | null {
  if (!loc.startsWith(ARTICLE_URL_PREFIX)) {
    return null;
  }
  const rest = loc.slice(ARTICLE_URL_PREFIX.length);
  if (!rest || rest.includes('/')) {
    return null;
  }
  return decodeURIComponent(rest.replace(/\+/g, ' '));
}

export function lastmodToUpdatedAt(lastmod: string): string {
  return lastmod
    .replace('T', ' ')
    .replace(/[+-]\d{2}:\d{2}$/, '')
    .slice(0, 19);
}

export function lastmodToEpochMs(lastmod: string): number {
  return new Date(lastmod).getTime();
}
