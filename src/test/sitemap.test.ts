import { test, expect } from 'bun:test';
import { IGNORED_WAF_TAGS } from '../constants';
import {
  isJapaneseSitemapPart,
  lastmodToEpochMs,
  lastmodToUpdatedAt,
  parseSitemapIndex,
  parseUrlset,
  SitemapSchemaError,
  tagNameFromArticleUrl,
} from '../helpers/sitemap';

test('parseSitemapIndex extracts japanese parts', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://dic.pixiv.net/sitemap/part/1</loc><lastmod>2026-08-27T06:07:32+09:00</lastmod></sitemap><sitemap><loc>https://dic.pixiv.net/en/sitemap/part/1</loc><lastmod>2026-08-20T22:39:31+09:00</lastmod></sitemap></sitemapindex>`;
  const entries = parseSitemapIndex(xml);
  expect(entries).toEqual([
    {
      loc: 'https://dic.pixiv.net/sitemap/part/1',
      lastmod: '2026-08-27T06:07:32+09:00',
    },
    {
      loc: 'https://dic.pixiv.net/en/sitemap/part/1',
      lastmod: '2026-08-20T22:39:31+09:00',
    },
  ]);
  expect(isJapaneseSitemapPart(entries[0].loc)).toBe(true);
  expect(isJapaneseSitemapPart(entries[1].loc)).toBe(false);
});

test('parseUrlset extracts article tags and lastmod', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://dic.pixiv.net/a/%E3%83%95%E3%83%AA%E3%83%BC%E3%83%AC%E3%83%B3</loc><lastmod>2026-04-19T18:25:09+09:00</lastmod><changefreq>Monthly</changefreq><priority>0.4</priority></url><url><loc>https://dic.pixiv.net/en/a/frieren</loc><lastmod>2026-04-19T18:25:09+09:00</lastmod></url></urlset>`;
  const entries = parseUrlset(xml);
  expect(tagNameFromArticleUrl(entries[0].loc)).toBe('フリーレン');
  expect(tagNameFromArticleUrl(entries[1].loc)).toBeNull();
  expect(tagNameFromArticleUrl('https://dic.pixiv.net/a/MELTY+BLOOD')).toBe(
    'MELTY BLOOD',
  );
  expect(tagNameFromArticleUrl('https://dic.pixiv.net/a/MELTY%20BLOOD')).toBe(
    'MELTY BLOOD',
  );
  expect(tagNameFromArticleUrl('https://dic.pixiv.net/a/C%2B%2B')).toBe('C++');
  expect(lastmodToUpdatedAt(entries[0].lastmod)).toBe('2026-04-19 18:25:09');
  expect(lastmodToEpochMs(entries[0].lastmod)).toBe(
    new Date('2026-04-19T18:25:09+09:00').getTime(),
  );
});

test('the known WAF vandalism tags are explicitly ignored', () => {
  expect([...IGNORED_WAF_TAGS]).toEqual([
    '..',
    '</title><svg onload=alert();>',
    `'"><script>alert(1)</script>`,
  ]);
});

test('accepts legitimately empty URL sets including a self-closing root', () => {
  expect(parseUrlset('<urlset></urlset>')).toEqual([]);
  expect(
    parseUrlset(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" />',
    ),
  ).toEqual([]);
  expect(
    parseUrlset(
      '<?xml version="1.0"?>\n<!-- no articles -->\n<urlset>\n</urlset>',
    ),
  ).toEqual([]);
});

for (const xml of [
  '<html><title>Service unavailable</title></html>',
  '<urlset></urlset>',
  '<sitemapindex>',
  '<sitemapindex></sitemapindex>',
  '<sitemapindex><sitemap><loc>https://dic.pixiv.net/sitemap/part/1</loc></sitemap></sitemapindex>',
  '<sitemapindex><sitemap><loc>https://dic.pixiv.net/sitemap/part/1</loc><lastmod>not a date</lastmod></sitemap></sitemapindex>',
]) {
  test(`rejects invalid sitemap indexes rather than reporting no parts: ${xml}`, () => {
    expect(() => parseSitemapIndex(xml)).toThrow(SitemapSchemaError);
  });
}

const URL_ENTRY =
  '<url><loc>https://dic.pixiv.net/a/example</loc><lastmod>2026-10-08T00:00:00+09:00</lastmod></url>';

for (const xml of [
  '<html><title>Just a moment...</title></html>',
  '<sitemapindex></sitemapindex>',
  `<urlset>${URL_ENTRY}`,
  `<urlset>${URL_ENTRY.replace('</url>', '')}</urlset>`,
  `<urlset>${URL_ENTRY}<url><loc>incomplete entry</loc></url></urlset>`,
  `<urlset>${URL_ENTRY.replace('2026-10-08T00:00:00+09:00', 'invalid')}</urlset>`,
  `<urlset>${URL_ENTRY}</urlset><html></html>`,
  `<urlset>${URL_ENTRY}<unexpected /></urlset>`,
]) {
  test(`rejects invalid sitemap parts before a caller can advance its checkpoint: ${xml}`, () => {
    expect(() => parseUrlset(xml)).toThrow(SitemapSchemaError);
  });
}

test('accepts declarations, comments, and surrounding XML whitespace', () => {
  expect(
    parseUrlset(
      `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- sitemap -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${URL_ENTRY}\n<!-- end -->\n</urlset>\n`,
    ),
  ).toEqual([
    {
      loc: 'https://dic.pixiv.net/a/example',
      lastmod: '2026-10-08T00:00:00+09:00',
    },
  ]);
});
