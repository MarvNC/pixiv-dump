import { expect, test } from 'bun:test';
import {
  CloudflareError,
  FetchSetupError,
  FetchTimeoutError,
  HttpError,
} from '../fetch/errors';
import { ArticleSchemaError } from '../scrape/scrapeSingleArticleInfo';
import { sanitizedSmokeError } from '../smoke/diagnostics';

const SECRET = 'secret-cookie-value-and-private-response';

test('smoke diagnostics allow only safe categories and bounded HTTP status', () => {
  const error = new HttpError(503, SECRET);
  Object.assign(error, { headers: { authorization: SECRET }, body: SECRET });

  expect(sanitizedSmokeError(error)).toEqual({
    category: 'http',
    httpStatus: 503,
  });
  expect(JSON.stringify(sanitizedSmokeError(error))).not.toContain(SECRET);
  expect(sanitizedSmokeError(new HttpError(123456789, SECRET))).toEqual({
    category: 'http',
  });
});

test('smoke diagnostics retain only bounded Cloudflare retry hints', () => {
  expect(sanitizedSmokeError(new CloudflareError(SECRET, 60_000))).toEqual({
    category: 'cloudflare',
    retryAfterMs: 60_000,
  });
  for (const hint of [Infinity, NaN, -1, 86_400_001]) {
    expect(sanitizedSmokeError(new CloudflareError(SECRET, hint))).toEqual({
      category: 'cloudflare',
    });
  }
});

test('smoke diagnostics distinguish parse and setup failures from site blocking', () => {
  expect(sanitizedSmokeError(new SyntaxError(SECRET))).toEqual({
    category: 'parse',
  });
  expect(sanitizedSmokeError(new ArticleSchemaError(SECRET))).toEqual({
    category: 'parse',
  });
  expect(sanitizedSmokeError(new FetchSetupError(new Error(SECRET)))).toEqual({
    category: 'setup',
  });
});

test('smoke diagnostics classify timeouts and transport failures without raw details', () => {
  expect(sanitizedSmokeError(new FetchTimeoutError(true))).toEqual({
    category: 'timeout',
    budgetExhausted: true,
  });
  expect(
    sanitizedSmokeError(
      Object.assign(new Error(SECRET), { code: 'ECONNRESET' }),
    ),
  ).toEqual({ category: 'transport' });
});

test('smoke diagnostics do not serialize unknown error names, causes, or values', () => {
  for (const error of [
    Object.assign(new Error(SECRET, { cause: SECRET }), { name: SECRET }),
    { token: SECRET },
    SECRET,
    null,
  ]) {
    expect(sanitizedSmokeError(error)).toEqual({ category: 'unexpected' });
  }
});
