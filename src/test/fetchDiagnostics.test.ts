import { expect, test } from 'bun:test';
import {
  recordFetchDiagnostic,
  fetchDiagnostic,
  recordPrecedingChallenge,
  withFetchOperation,
} from '../fetch/diagnostics';
import { CloudflareError, FetchTimeoutError } from '../fetch/errors';
import { sanitizedSmokeError } from '../smoke/diagnostics';

const SECRET = 'secret-tag-cookie-query-body';

for (const [path, endpoint] of [
  ['/_api/get_article/', 'article'],
  ['/_api/get_breadcrumbs/', 'breadcrumbs'],
  ['/_api/get_article_info/', 'article-info'],
  ['/sitemap/part.xml', 'sitemap'],
  ['/sitemap.xml', 'sitemap'],
  ['/unknown/', 'other'],
] as const) {
  test(`diagnostics identify only the ${endpoint} endpoint category`, () => {
    const error = new CloudflareError(SECRET, 60_000);
    recordFetchDiagnostic(
      error,
      `https://dic.pixiv.net${path}${SECRET}?token=${SECRET}`,
      'browser',
      { status: 403, contentType: `text/html; secret=${SECRET}` },
      'header',
    );
    expect(sanitizedSmokeError(error)).toEqual({
      category: 'cloudflare',
      retryAfterMs: 60_000,
      request: {
        endpoint,
        transport: 'browser',
        httpStatus: 403,
        contentType: 'html',
        challengeDetection: 'header',
      },
    });
    expect(JSON.stringify(sanitizedSmokeError(error))).not.toContain(SECRET);
  });
}

test('arbitrary properties on an error cannot inject request diagnostics', () => {
  const error = Object.assign(new Error(SECRET), {
    request: { endpoint: SECRET },
    diagnostic: SECRET,
  });
  expect(fetchDiagnostic(error)).toBeUndefined();
  expect(sanitizedSmokeError(error)).toEqual({ category: 'unexpected' });
});

test('diagnostics reject foreign origins and bound status/content type', () => {
  for (const url of [
    'https://dic.pixiv.net.attacker.invalid/_api/get_article/secret',
    SECRET,
  ]) {
    const error = new Error(SECRET);
    recordFetchDiagnostic(error, url, 'http', {
      status: 1234567,
      contentType: SECRET,
    });
    expect(fetchDiagnostic(error)).toEqual({
      endpoint: 'other',
      transport: 'http',
      contentType: 'other',
    });
  }
});

test('outer failure handling preserves deeper response evidence without exposing mutable state', () => {
  const error = new Error(SECRET);
  const url = 'https://dic.pixiv.net/_api/get_breadcrumbs/secret';
  recordFetchDiagnostic(
    error,
    url,
    'browser',
    { status: 403, contentType: 'text/html' },
    'title',
  );
  recordFetchDiagnostic(error, url, 'http');
  const copy = fetchDiagnostic(error)!;
  copy.endpoint = 'other';
  expect(fetchDiagnostic(error)).toEqual({
    endpoint: 'breadcrumbs',
    transport: 'browser',
    httpStatus: 403,
    contentType: 'html',
    challengeDetection: 'title',
  });
});

test('sanitized operation and historical evidence preserve identity and cannot expose mutable internals', async () => {
  const error = new FetchTimeoutError(true);
  const url = `https://dic.pixiv.net/_api/get_article/${SECRET}?token=${SECRET}`;
  await expect(
    withFetchOperation('browser-session', () =>
      withFetchOperation('navigation-response-body', async () => {
        throw error;
      }),
    ),
  ).rejects.toBe(error);
  recordPrecedingChallenge(
    error,
    url,
    { status: 403, contentType: `text/html; private=${SECRET}` },
    'header',
  );
  recordPrecedingChallenge(
    error,
    url,
    { status: 200, contentType: 'application/json' },
    'body',
  );
  recordFetchDiagnostic(error, url, 'browser', {
    status: 200,
    contentType: 'application/json',
  });
  const copy = fetchDiagnostic(error)!;
  copy.precedingChallenge!.httpStatus = 500;
  expect(sanitizedSmokeError(error)).toEqual({
    category: 'timeout',
    budgetExhausted: true,
    request: {
      endpoint: 'article',
      transport: 'browser',
      operation: 'navigation-response-body',
      httpStatus: 200,
      contentType: 'json',
      precedingChallenge: {
        httpStatus: 403,
        contentType: 'html',
        challengeDetection: 'header',
      },
    },
  });
  expect(JSON.stringify(sanitizedSmokeError(error))).not.toContain(SECRET);
});

test('operation and challenge context reject runtime values outside their allowlists', async () => {
  const error = new FetchTimeoutError(true);
  await expect(
    withFetchOperation(
      SECRET as Parameters<typeof withFetchOperation>[0],
      async () => {
        throw error;
      },
    ),
  ).rejects.toBe(error);
  recordPrecedingChallenge(
    error,
    'https://dic.pixiv.net/sitemap.xml',
    { status: 123456, contentType: SECRET },
    SECRET as Parameters<typeof recordPrecedingChallenge>[3],
  );
  expect(sanitizedSmokeError(error)).toEqual({
    category: 'timeout',
    budgetExhausted: true,
    request: {
      endpoint: 'sitemap',
      transport: 'browser',
      precedingChallenge: { contentType: 'other' },
    },
  });
  expect(JSON.stringify(sanitizedSmokeError(error))).not.toContain(SECRET);
});
