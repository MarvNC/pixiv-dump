export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class CloudflareError extends Error {
  constructor(
    message = 'Blocked by Cloudflare challenge',
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'CloudflareError';
  }
}

export class FetchTimeoutError extends Error {
  constructor(readonly budgetExhausted = false) {
    super(
      budgetExhausted
        ? 'Fetch time budget exhausted'
        : 'Fetch operation timed out',
    );
    this.name = 'FetchTimeoutError';
  }
}

export class FetchSetupError extends Error {
  constructor(cause: unknown) {
    super('Fetch client setup failed', { cause });
    this.name = 'FetchSetupError';
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isTransientFetchError(error: unknown): boolean {
  if (error instanceof FetchTimeoutError) return !error.budgetExhausted;
  if (error instanceof CloudflareError) return true;
  if (error instanceof HttpError) {
    return (
      error.status === 408 ||
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599)
    );
  }
  if (
    !(error instanceof Error) ||
    error instanceof FetchSetupError ||
    error instanceof SyntaxError ||
    error.name === 'AssertionError'
  )
    return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  // Browser fetch failures and navigation races have no structured error code.
  // Do not treat arbitrary TypeErrors, RequestErrors, or setup errors as network failures.
  if (
    /^(?:page\.(?:evaluate|goto): )?(?:Failed to fetch|fetch failed|NetworkError when attempting to fetch resource\.?)(?:$|\n)/.test(
      error.message,
    )
  )
    return true;
  if (
    /^page\.(?:evaluate|title|waitForFunction): (?:Execution context was destroyed|Cannot find context with specified id)/.test(
      error.message,
    )
  )
    return true;
  if (
    /^page\.goto: net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED)\b/.test(
      error.message,
    )
  )
    return true;
  // wreq 3.x flattens native causes; match its transport prefix and an
  // allowlisted final cause, never all RequestErrors (which include bad config).
  if (
    error.name === 'RequestError' &&
    /^Error: (?:GET|HEAD) .*: error sending request for uri \(/.test(
      error.message,
    ) &&
    /: (?:operation timed out|connection reset by peer|connection refused|temporary failure in name resolution|broken pipe)(?: \(os error \d+\))?$/i.test(
      error.message,
    )
  )
    return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  return (
    cause instanceof Error &&
    cause !== error &&
    typeof (cause as Error & { code?: unknown }).code === 'string' &&
    TRANSIENT_CODES.has((cause as Error & { code: string }).code)
  );
}

export function fetchErrorCategory(
  error: unknown,
): 'cloudflare' | 'http' | 'timeout' | 'transport' | 'unexpected' {
  if (error instanceof CloudflareError) return 'cloudflare';
  if (error instanceof HttpError) return 'http';
  if (
    error instanceof FetchTimeoutError ||
    (error instanceof Error && error.name === 'TimeoutError')
  )
    return 'timeout';
  return isTransientFetchError(error) ? 'transport' : 'unexpected';
}

export class FetchCleanupError extends Error {
  constructor(cause: unknown) {
    super('Fetch client cleanup failed', { cause });
    this.name = 'FetchCleanupError';
  }
}
