import { PIXIV_BASE_URL } from '../constants';

const OPERATIONS = [
  'browser-session',
  'homepage-navigation',
  'challenge-wait',
  'session-cookie-wait',
  'document-readiness',
  'browser-request',
  'target-navigation',
  'navigation-response-body',
] as const;
type FetchOperation = (typeof OPERATIONS)[number];
type ResponseDiagnostic = {
  httpStatus?: number;
  contentType?: 'json' | 'html' | 'xml' | 'other';
  challengeDetection?: 'header' | 'title' | 'body';
};
type FetchDiagnostic = {
  endpoint: 'article' | 'breadcrumbs' | 'article-info' | 'sitemap' | 'other';
  transport: 'http' | 'browser';
  httpStatus?: number;
  contentType?: 'json' | 'html' | 'xml' | 'other';
  challengeDetection?: 'header' | 'title' | 'body';
  operation?: FetchOperation;
  precedingChallenge?: ResponseDiagnostic;
};

const operations = new WeakMap<Error, FetchOperation>();
const challengeDetections = new WeakMap<
  Error,
  NonNullable<ResponseDiagnostic['challengeDetection']>
>();
const diagnostics = new WeakMap<Error, FetchDiagnostic>();

function endpointCategory(url: string): FetchDiagnostic['endpoint'] {
  try {
    const target = new URL(url);
    if (target.origin !== new URL(PIXIV_BASE_URL).origin) return 'other';
    const path = target.pathname;
    if (path.startsWith('/_api/get_article/')) return 'article';
    if (path.startsWith('/_api/get_breadcrumbs/')) return 'breadcrumbs';
    if (path.startsWith('/_api/get_article_info/')) return 'article-info';
    if (/^\/sitemap(?:[/.]|$)/.test(path)) return 'sitemap';
  } catch {
    // Never publish arbitrary URLs, tags, query values, or parser messages.
  }
  return 'other';
}

export function recordFetchDiagnostic(
  error: unknown,
  url: string,
  transport: FetchDiagnostic['transport'],
  response?: { status: number; contentType: string },
  challengeDetection?: FetchDiagnostic['challengeDetection'],
): void {
  if (!(error instanceof Error)) return;
  const previous = diagnostics.get(error);
  const contentType = response?.contentType
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  diagnostics.set(error, {
    endpoint: endpointCategory(url),
    transport,
    ...previous,
    ...(response &&
    Number.isInteger(response.status) &&
    response.status >= 100 &&
    response.status <= 599
      ? { httpStatus: response.status }
      : {}),
    ...(response
      ? {
          contentType:
            contentType === 'application/json' || contentType?.endsWith('+json')
              ? 'json'
              : contentType === 'text/html'
                ? 'html'
                : contentType === 'application/xml' ||
                    contentType === 'text/xml'
                  ? 'xml'
                  : 'other',
        }
      : {}),
    ...(challengeDetection &&
    ['header', 'title', 'body'].includes(challengeDetection)
      ? { challengeDetection }
      : {}),
  });
}

// Preserve the innermost active operation without changing error identity or
// category. The names are fixed labels, never raw browser error messages.
export async function withFetchOperation<T>(
  operation: FetchOperation,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof Error &&
      !operations.has(error) &&
      OPERATIONS.includes(operation)
    ) {
      operations.set(error, operation);
    }
    throw error;
  }
}

export function recordChallengeWait(error: unknown): void {
  if (error instanceof Error) challengeDetections.set(error, 'title');
}

export function recordPrecedingChallenge(
  error: unknown,
  url: string,
  response: { status: number; contentType: string },
  challengeDetection: ResponseDiagnostic['challengeDetection'],
): void {
  if (!(error instanceof Error)) return;
  // Reuse the same allowlisted sanitization; historical evidence must not look
  // like the response of the operation that ultimately timed out.
  const prior = new Error();
  recordFetchDiagnostic(prior, url, 'browser', response, challengeDetection);
  const {
    httpStatus,
    contentType,
    challengeDetection: detection,
  } = diagnostics.get(prior)!;
  recordFetchDiagnostic(error, url, 'browser');
  diagnostics.get(error)!.precedingChallenge ??= {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(contentType ? { contentType } : {}),
    ...(detection ? { challengeDetection: detection } : {}),
  };
}

export function fetchDiagnostic(error: unknown): FetchDiagnostic | undefined {
  const diagnostic =
    error instanceof Error ? diagnostics.get(error) : undefined;
  return diagnostic
    ? {
        ...(error instanceof Error && challengeDetections.has(error)
          ? { challengeDetection: challengeDetections.get(error)! }
          : {}),
        ...diagnostic,
        ...(error instanceof Error && operations.has(error)
          ? { operation: operations.get(error)! }
          : {}),
        ...(diagnostic.precedingChallenge
          ? { precedingChallenge: { ...diagnostic.precedingChallenge } }
          : {}),
      }
    : undefined;
}
