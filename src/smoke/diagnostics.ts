import {
  CloudflareError,
  fetchErrorCategory,
  FetchTimeoutError,
  FetchSetupError,
  HttpError,
} from '../fetch/errors';
import { ArticleSchemaError } from '../scrape/scrapeSingleArticleInfo';

export function sanitizedSmokeError(error: unknown) {
  const category =
    error instanceof SyntaxError || error instanceof ArticleSchemaError
      ? 'parse'
      : error instanceof FetchSetupError
        ? 'setup'
        : fetchErrorCategory(error);
  // Only emit explicitly selected, bounded numeric/boolean properties. Never
  // serialize the error, its message/stack/cause, response bodies, or headers.
  return {
    category,
    ...(error instanceof HttpError &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? { httpStatus: error.status }
      : {}),
    ...(error instanceof CloudflareError &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs >= 0 &&
    error.retryAfterMs <= 86_400_000
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
    ...(error instanceof FetchTimeoutError
      ? { budgetExhausted: error.budgetExhausted === true }
      : {}),
  };
}
