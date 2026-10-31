import { expect, test } from 'bun:test';
import { recordFetchDiagnostic, fetchDiagnostic } from '../fetch/diagnostics';
import { CloudflareError } from '../fetch/errors';
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
