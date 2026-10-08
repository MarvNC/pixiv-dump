import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PIXIV_API_BASE_URL } from '../constants';
import * as transport from '../fetch/fetchURL';
import { CloudflareError, HttpError } from '../fetch/errors';
import {
  ArticleNotFoundError,
  ArticleSchemaError,
  scrapeSingleArticleInfo,
  type ScrapedArticle,
} from '../scrape/scrapeSingleArticleInfo';

type Endpoint = 'get_article' | 'get_breadcrumbs' | 'get_article_info';
type Fixture = {
  tagName: string;
  responses: Record<Endpoint, unknown>;
  expected: ScrapedArticle;
};

function loadFixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/articles/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as Fixture;
}

const richFixture = loadFixture('rich');
const minimalFixture = loadFixture('minimal');
const endpoints: Endpoint[] = [
  'get_article',
  'get_breadcrumbs',
  'get_article_info',
];
let fixture: Fixture;
let failures: Partial<Record<Endpoint, Error>>;
let fetchURL: ReturnType<typeof spyOn<typeof transport, 'fetchURL'>>;

function expectedUrl(endpoint: Endpoint) {
  return `${PIXIV_API_BASE_URL}/${endpoint}/${encodeURIComponent(fixture.tagName)}?lang=ja`;
}

beforeEach(() => {
  fixture = structuredClone(richFixture);
  failures = {};
  // Exercise the production scraper and parser with fixed endpoint responses.
  // Unknown URLs fail locally; this spy never delegates to a network client.
  fetchURL = spyOn(transport, 'fetchURL').mockImplementation(async (url) => {
    const endpoint = endpoints.find(
      (endpoint) => expectedUrl(endpoint) === url,
    );
    if (!endpoint) {
      throw new Error('Unexpected endpoint in offline article test');
    }
    if (failures[endpoint]) {
      throw failures[endpoint];
    }
    return { status: 200, data: fixture.responses[endpoint] };
  });
});

afterEach(() => {
  fetchURL.mockRestore();
});

test('parses all fields, nested text, first section, relationships, and JST from the rich fixture', async () => {
  expect(await scrapeSingleArticleInfo(fixture.tagName)).toEqual(
    fixture.expected,
  );
  expect(fetchURL.mock.calls).toEqual(
    endpoints.map((endpoint) => [expectedUrl(endpoint)]),
  );
});

test('handles a headingless article, absent fields, zero counts, and URL-encoded tags', async () => {
  fixture = structuredClone(minimalFixture);
  expect(await scrapeSingleArticleInfo(fixture.tagName)).toEqual(
    fixture.expected,
  );
  expect(fetchURL.mock.calls).toEqual(
    endpoints.map((endpoint) => [expectedUrl(endpoint)]),
  );
});

test('falls back to categories when breadcrumbs are empty without mutating the response', async () => {
  fixture.responses.get_breadcrumbs = [];
  const article = fixture.responses.get_article as { categories: string[] };
  article.categories = ['予備カテゴリ', fixture.tagName];

  const result = await scrapeSingleArticleInfo(fixture.tagName);

  expect(result.header).toEqual(['予備カテゴリ', fixture.tagName]);
  expect(article.categories).toEqual(['予備カテゴリ', fixture.tagName]);
});

test('does not append the article tag twice when breadcrumbs already include it', async () => {
  fixture.responses.get_breadcrumbs = [
    { tagName: '親記事', url: '/a/親記事' },
    { tagName: fixture.tagName, url: '/a/フリーレン' },
  ];

  expect((await scrapeSingleArticleInfo(fixture.tagName)).header).toEqual([
    '親記事',
    fixture.tagName,
  ]);
});

test('optional endpoint 404 responses preserve article content and undefined counts', async () => {
  failures.get_breadcrumbs = new HttpError(404, 'Optional breadcrumbs missing');
  failures.get_article_info = new HttpError(404, 'Optional counts unavailable');

  expect(await scrapeSingleArticleInfo(fixture.tagName)).toEqual({
    ...fixture.expected,
    header: ['予備カテゴリ', fixture.tagName],
    view_count: undefined,
    illust_count: undefined,
    check_count: undefined,
  });
  expect(fetchURL).toHaveBeenCalledTimes(3);
});

for (const endpoint of endpoints) {
  test(`preserves a Cloudflare failure from ${endpoint} instead of returning a partial success`, async () => {
    const error = new CloudflareError('Fixture challenge');
    failures[endpoint] = error;

    await expect(scrapeSingleArticleInfo(fixture.tagName)).rejects.toBe(error);
    expect(fetchURL).toHaveBeenCalledTimes(endpoints.indexOf(endpoint) + 1);
  });
}

test('maps only the required article endpoint 404 to ArticleNotFoundError', async () => {
  failures.get_article = new HttpError(404, 'Article missing');

  await expect(scrapeSingleArticleInfo(fixture.tagName)).rejects.toBeInstanceOf(
    ArticleNotFoundError,
  );
  expect(fetchURL).toHaveBeenCalledTimes(1);
});

test('preserves non-404 required article failures', async () => {
  const error = new HttpError(503, 'Fixture service unavailable');
  failures.get_article = error;

  await expect(scrapeSingleArticleInfo(fixture.tagName)).rejects.toBe(error);
  expect(fetchURL).toHaveBeenCalledTimes(1);
});

test('rejects malformed serialized nodes rather than reporting empty article text', async () => {
  fixture.responses.get_article = { nodes: '{not valid JSON' };

  await expect(scrapeSingleArticleInfo(fixture.tagName)).rejects.toBeInstanceOf(
    SyntaxError,
  );
});

test('uses abstract-only text when the response has no nodes', async () => {
  fixture.responses.get_article = { abstract: '要約だけの記事。' };

  const result = await scrapeSingleArticleInfo(fixture.tagName);

  expect(result.mainText).toBe('要約だけの記事。');
  expect(result.summary).toBe('要約だけの記事。');
});

for (const endpoint of ['get_breadcrumbs', 'get_article_info'] as const) {
  for (const error of [
    new HttpError(503, 'Fixture service failure'),
    new HttpError(429, 'Fixture rate limit'),
    new SyntaxError('Fixture invalid JSON'),
    new Error('Fixture unexpected setup failure'),
  ]) {
    test(`does not swallow optional ${endpoint} ${error.name} failures`, async () => {
      failures[endpoint] = error;

      await expect(scrapeSingleArticleInfo(fixture.tagName)).rejects.toBe(
        error,
      );
      expect(fetchURL).toHaveBeenCalledTimes(endpoints.indexOf(endpoint) + 1);
    });
  }
}

for (const response of [
  null,
  '<html>challenge</html>',
  [],
  {},
  { error: 'bad response' },
  { abstract: 12 },
  { nodes: [] },
  { categories: [12] },
  { relatedArticles: { child_articles: ['bad'] } },
  { mainIllust: 'bad' },
  { updatedAtTimestamp: 1e100 },
]) {
  test(`rejects invalid required article shape ${JSON.stringify(response)}`, async () => {
    fixture.responses.get_article = response;

    await expect(
      scrapeSingleArticleInfo(fixture.tagName),
    ).rejects.toBeInstanceOf(ArticleSchemaError);
    expect(fetchURL).toHaveBeenCalledTimes(1);
  });
}

for (const nodes of [null, {}, ['not a node'], [{ tag: 'p', children: {} }]]) {
  test(`rejects invalid serialized node shape ${JSON.stringify(nodes)}`, async () => {
    fixture.responses.get_article = { nodes: JSON.stringify(nodes) };

    await expect(
      scrapeSingleArticleInfo(fixture.tagName),
    ).rejects.toBeInstanceOf(ArticleSchemaError);
  });
}

for (const [endpoint, response] of [
  ['get_breadcrumbs', {}],
  ['get_breadcrumbs', [{ tagName: 12 }]],
  ['get_article_info', []],
  ['get_article_info', {}],
  ['get_article_info', { articleViewCount: '12' }],
  ['get_article_info', { articleViewCount: -1 }],
] as const) {
  test(`rejects invalid optional ${endpoint} shape ${JSON.stringify(response)}`, async () => {
    fixture.responses[endpoint] = response;

    await expect(
      scrapeSingleArticleInfo(fixture.tagName),
    ).rejects.toBeInstanceOf(ArticleSchemaError);
  });
}

test('preserves nullable optional API fields as empty defaults', async () => {
  fixture.responses.get_article = {
    abstract: null,
    yomigana: null,
    categories: null,
    nodes: null,
    mainIllust: null,
    relatedArticles: null,
    updatedAtTimestamp: null,
  };
  fixture.responses.get_breadcrumbs = [];
  fixture.responses.get_article_info = {
    articleViewCount: null,
    pixivWorkCount: null,
    checklistCount: null,
  };

  expect(await scrapeSingleArticleInfo(fixture.tagName)).toEqual({
    reading: '',
    header: [fixture.tagName],
    mainText: '',
    summary: '',
    parent: null,
    related_tags: [],
    main_illst_url: '',
    view_count: undefined,
    illust_count: undefined,
    check_count: undefined,
    updated_at: '',
  });
});
