import { PIXIV_BASE_URL } from '../constants';

type FetchDiagnostic = {
  endpoint: 'article' | 'breadcrumbs' | 'article-info' | 'sitemap' | 'other';
  transport: 'http' | 'browser';
  httpStatus?: number;
  contentType?: 'json' | 'html' | 'xml' | 'other';
  challengeDetection?: 'header' | 'title' | 'body';
};

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
    ...(challengeDetection ? { challengeDetection } : {}),
  });
}

export function fetchDiagnostic(error: unknown): FetchDiagnostic | undefined {
  const diagnostic =
    error instanceof Error ? diagnostics.get(error) : undefined;
  return diagnostic ? { ...diagnostic } : undefined;
}
