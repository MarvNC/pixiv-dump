import { test, expect } from 'bun:test';
import {
  isJapaneseSitemapPart,
  lastmodToEpochMs,
  lastmodToUpdatedAt,
  parseSitemapIndex,
  parseUrlset,
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
