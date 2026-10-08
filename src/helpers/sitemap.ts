export type SitemapEntry = {
  loc: string;
  lastmod: string;
};

const ARTICLE_URL_PREFIX = 'https://dic.pixiv.net/a/';
const JA_SITEMAP_PART_PREFIX = 'https://dic.pixiv.net/sitemap/part/';

export class SitemapSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SitemapSchemaError';
  }
}

function parseEntries(
  xml: string,
  root: 'sitemapindex' | 'urlset',
  pattern: RegExp,
): SitemapEntry[] {
  // Validate the entire supported document, rather than silently treating an
  // HTML error page, truncated XML, or an unrecognized entry as an empty part.
  const document = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
    .replace(/^<\?xml\s[^?]*\?>\s*/, '');
  const rootPattern = new RegExp(
    `^<${root}(?:\\s+[^<>]*?)?\\s*>([\\s\\S]*)<\\/${root}\\s*>$`,
  );
  const emptyRootPattern = new RegExp(`^<${root}(?:\\s+[^<>]*?)?\\s*\\/>$`);
  const match = rootPattern.exec(document);
  const body = match?.[1] ?? (emptyRootPattern.test(document) ? '' : null);
  if (body === null) {
    throw new SitemapSchemaError(`Expected a complete ${root} XML document`);
  }
  const entries: SitemapEntry[] = [];
  const unparsed = body.replace(pattern, (_entry, rawLoc, rawLastmod) => {
    const loc = String(rawLoc).trim();
    const lastmod = String(rawLastmod).trim();
    if (!loc || !lastmod || !Number.isFinite(Date.parse(lastmod))) {
      throw new SitemapSchemaError(
        'Sitemap entry has an invalid location or date',
      );
    }
    entries.push({ loc, lastmod });
    return '';
  });
  if (unparsed.trim() !== '') {
    throw new SitemapSchemaError(
      'Sitemap contains an unsupported or incomplete entry',
    );
  }
  if (root === 'sitemapindex' && entries.length === 0) {
    throw new SitemapSchemaError('Sitemap index has no parts');
  }
  return entries;
}

export function parseSitemapIndex(xml: string): SitemapEntry[] {
  return parseEntries(
    xml,
    'sitemapindex',
    /<sitemap>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/sitemap>/g,
  );
}

export function parseUrlset(xml: string): SitemapEntry[] {
  return parseEntries(
    xml,
    'urlset',
    /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*(?:(?:<changefreq>[^<]*<\/changefreq>|<priority>[^<]*<\/priority>)\s*)*<\/url>/g,
  );
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
