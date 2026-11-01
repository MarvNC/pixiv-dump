import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { chromium, type Browser, type Response } from 'playwright';
import { PIXIV_BASE_URL } from '../constants';
import { CloudflareError, FetchCleanupError } from '../fetch/errors';
import { FetchBudget } from '../fetch/budget';
import {
  closeBrowser,
  fetchWithBrowser,
  solveCloudflare,
} from '../fetch/solveCloudflare';

const TARGET_URL = `${PIXIV_BASE_URL}sitemap.xml`;
const PAGE_TITLE = 'ピクシブ百科事典 - みんなでつくる百科事典';
const RESPONSE = {
  status: 200,
  text: '<sitemapindex></sitemapindex>',
  contentType: 'application/xml',
};
const CHALLENGE_BODY =
  '<html><title>Just a moment...</title><script src="/challenge-platform"></script></html>';

function navigationError() {
  return new Error(
    'page.evaluate: Execution context was destroyed, most likely because of a navigation',
  );
}

function timeoutError() {
  const error = new Error('page.waitForFunction: Timeout 15000ms exceeded.');
  error.name = 'TimeoutError';
  return error;
}

function makeBrowser() {
  const document = { title: PAGE_TITLE, readyState: 'complete' };
  const location = { href: PIXIV_BASE_URL, pathname: '/' };
  let closed = false;
  const frame = {};
  const listeners = new Set<(response: Response) => void>();
  const navigationResponse = (
    url: string,
    response = RESPONSE,
    mainFrame = true,
    navigation = true,
  ) => ({
    url: () => url,
    request: () => ({ isNavigationRequest: () => navigation }),
    frame: () => (mainFrame ? frame : {}),
    status: () => response.status,
    text: mock(async () => response.text),
    allHeaders: mock(async () => ({ 'content-type': response.contentType })),
  });
  const emitResponse = (response: ReturnType<typeof navigationResponse>) => {
    for (const listener of listeners) listener(response as unknown as Response);
  };
  const page = {
    isClosed: () => closed,
    url: () => location.href,
    title: mock(async () => document.title),
    mainFrame: () => frame,
    on: mock((_event: string, listener: (response: Response) => void) => {
      listeners.add(listener);
    }),
    off: mock((_event: string, listener: (response: Response) => void) => {
      listeners.delete(listener);
    }),
    goto: mock(async (): Promise<Response | undefined> => undefined),
    waitForLoadState: mock(async () => undefined),
    waitForTimeout: mock(async () => undefined),
    waitForFunction: mock(
      async (
        predicate: (argument: unknown) => unknown,
        argument: unknown,
        options: { timeout: number },
      ) => {
        // Execute the real browser predicate against a local fake document.
        // A false predicate models its bounded timeout; no website is contacted.
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(120_000);
        const ready = runInNewContext(`(${predicate})(argument)`, {
          document,
          location,
          argument,
        });
        if (!ready) {
          throw timeoutError();
        }
        return { dispose: mock(async () => undefined) };
      },
    ),
    evaluate: mock(async () => RESPONSE),
    close: mock(async () => {
      closed = true;
    }),
  };
  const context = {
    newPage: mock(async () => page),
    cookies: mock(async () => [{ name: 'cf_clearance' }]),
    close: mock(async () => undefined),
  };
  const browser = {
    newContext: mock(async () => context),
    close: mock(async () => undefined),
  };
  return {
    document,
    location,
    page,
    context,
    browser,
    navigationResponse,
    emitResponse,
    listeners,
  };
}

let fixture: ReturnType<typeof makeBrowser>;
let launch: ReturnType<typeof spyOn<typeof chromium, 'launch'>>;

beforeEach(() => {
  fixture = makeBrowser();
  launch = spyOn(chromium, 'launch').mockResolvedValue(
    fixture.browser as unknown as Browser,
  );
});

afterEach(async () => {
  await closeBrowser();
  launch.mockRestore();
});

test('waits for the loading document to settle even with a clearance cookie', async () => {
  fixture.document.title = `Loading ${PIXIV_BASE_URL}`;
  fixture.document.readyState = 'loading';
  const waitForFunction = fixture.page.waitForFunction.getMockImplementation()!;
  fixture.page.waitForFunction.mockImplementationOnce(async (...args) => {
    await expect(waitForFunction(...args)).rejects.toThrow('Timeout');
    fixture.document.title = PAGE_TITLE;
    fixture.document.readyState = 'complete';
    return waitForFunction(...args);
  });

  expect(await solveCloudflare()).toBe(true);
  expect(fixture.document.title).toBe(PAGE_TITLE);
  expect(fixture.page.waitForLoadState).toHaveBeenCalled();
  expect(fixture.page.evaluate).not.toHaveBeenCalled();
});

test('a loading-page timeout is a failure even with a clearance cookie', async () => {
  fixture.document.title = `Loading ${PIXIV_BASE_URL}`;

  await expect(solveCloudflare()).rejects.toMatchObject({
    name: 'TimeoutError',
  });
  expect(fixture.page.evaluate).not.toHaveBeenCalled();
});

test('checks document readiness before fetching from the browser', async () => {
  fixture.document.readyState = 'loading';
  const waitForFunction = fixture.page.waitForFunction.getMockImplementation()!;
  fixture.page.waitForFunction.mockImplementationOnce(async (...args) => {
    await expect(waitForFunction(...args)).rejects.toThrow('Timeout');
    fixture.document.readyState = 'interactive';
    return waitForFunction(...args);
  });
  fixture.page.evaluate.mockImplementation(async () => {
    expect(fixture.document.readyState).toBe('interactive');
    return RESPONSE;
  });

  expect(await fetchWithBrowser(TARGET_URL)).toEqual(RESPONSE);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
});

test('retries a fetch whose execution context was destroyed by navigation', async () => {
  fixture.page.evaluate.mockRejectedValueOnce(navigationError());

  expect(await fetchWithBrowser(TARGET_URL)).toEqual(RESPONSE);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(2);
  expect(fixture.page.waitForLoadState).toHaveBeenCalled();
});

test('bounds retries when navigation keeps destroying the execution context', async () => {
  const error = navigationError();
  fixture.page.evaluate.mockRejectedValue(error);

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBe(error);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(3);
});

test('does not retry or replace unrelated browser fetch errors', async () => {
  const error = new TypeError('page.evaluate: Failed to fetch');
  fixture.page.evaluate.mockRejectedValue(error);

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBe(error);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
});

test('does not retry a closed page', async () => {
  const error = new Error(
    'page.evaluate: Target page, context or browser has been closed',
  );
  fixture.page.evaluate.mockRejectedValue(error);

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBe(error);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
});

for (const title of [
  'Just a moment...',
  'しばらくお待ちください...',
  'Attention Required!',
  'Access Denied',
  'You have been blocked',
]) {
  test(`a persistent ${JSON.stringify(title)} page is not solved by a cookie`, async () => {
    fixture.document.title = title;

    await expect(solveCloudflare()).rejects.toBeInstanceOf(CloudflareError);
    // Re-enter during the challenge-wait cooldown: it must still be a failure.
    await expect(fetchWithBrowser(TARGET_URL)).rejects.toBeInstanceOf(
      CloudflareError,
    );
    expect(fixture.page.evaluate).not.toHaveBeenCalled();
  });
}

test('persistent challenge response bodies still throw CloudflareError', async () => {
  fixture.page.evaluate.mockResolvedValue({
    ...RESPONSE,
    text: CHALLENGE_BODY,
    contentType: 'text/html',
  });

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBeInstanceOf(
    CloudflareError,
  );
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
  expect(fixture.page.goto).toHaveBeenCalledTimes(1);
});

test('a navigation retry does not turn a persistent challenge into success', async () => {
  fixture.page.evaluate
    .mockRejectedValueOnce(navigationError())
    .mockResolvedValue({
      ...RESPONSE,
      text: CHALLENGE_BODY,
      contentType: 'text/html',
    });
  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBeInstanceOf(
    CloudflareError,
  );
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(2);
});

test('uses an untitled JSON navigation response instead of another challenged XHR', async () => {
  const target = `${PIXIV_BASE_URL}_api/get_article/example`;
  const json = { status: 200, text: '{}', contentType: 'application/json' };
  fixture.page.evaluate.mockResolvedValue({
    ...RESPONSE,
    text: CHALLENGE_BODY,
    contentType: 'text/html',
  });
  fixture.page.goto.mockImplementation(async () => {
    fixture.location.href = target;
    fixture.location.pathname = '/_api/get_article/example';
    fixture.document.title = '';
    const response = fixture.navigationResponse(target, json);
    fixture.emitResponse(response);
    return response as unknown as Response;
  });
  expect(await fetchWithBrowser(target)).toEqual({ ...json, cfMitigated: '' });
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
  expect(fixture.listeners.size).toBe(0);
  fixture.page.evaluate.mockResolvedValue(RESPONSE);
  expect(await fetchWithBrowser(TARGET_URL)).toEqual(RESPONSE);
  expect(fixture.page.goto).toHaveBeenCalledTimes(1);
});

test('does not fetch again if waiting after a navigation error times out', async () => {
  const error = timeoutError();
  fixture.page.evaluate.mockRejectedValueOnce(navigationError());
  fixture.page.waitForLoadState
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(error);

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBe(error);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
});

test('retries navigation errors while checking the page title', async () => {
  fixture.page.title.mockRejectedValueOnce(navigationError());

  expect(await fetchWithBrowser(TARGET_URL)).toEqual(RESPONSE);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
  expect(fixture.page.waitForLoadState).toHaveBeenCalledTimes(2);
});

test('unrelated title errors are not hidden by session cookies', async () => {
  const error = new Error('page.title: unexpected browser error');
  fixture.page.title.mockRejectedValueOnce(error);

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBe(error);
  expect(fixture.page.evaluate).not.toHaveBeenCalled();
});

test('an empty homepage title is not ready', async () => {
  fixture.document.title = '';

  await expect(solveCloudflare()).rejects.toMatchObject({
    name: 'TimeoutError',
  });
  expect(fixture.page.evaluate).not.toHaveBeenCalled();
});

for (const finalTitle of [`Loading ${PIXIV_BASE_URL}`, 'Access Denied', '']) {
  test(`does not report success if the last observed title becomes ${JSON.stringify(finalTitle)}`, async () => {
    fixture.page.title
      .mockResolvedValueOnce(PAGE_TITLE)
      .mockResolvedValueOnce(PAGE_TITLE)
      .mockResolvedValue(finalTitle);

    expect(await solveCloudflare()).toBe(false);
    expect(fixture.page.evaluate).not.toHaveBeenCalled();
  });
}

test('a sitemap challenge after a timed-out homepage wait carries its remaining cooldown', async () => {
  let now = 1_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const waitForFunction = fixture.page.waitForFunction.getMockImplementation()!;
  fixture.document.title = 'Just a moment...';
  fixture.page.waitForFunction.mockImplementationOnce(async () => {
    now += 120_000;
    throw timeoutError();
  });
  try {
    await expect(solveCloudflare()).rejects.toBeInstanceOf(CloudflareError);
    now += 5000;
    fixture.document.title = PAGE_TITLE;
    expect(await solveCloudflare()).toBe(true);
    fixture.page.evaluate.mockResolvedValueOnce({
      ...RESPONSE,
      text: CHALLENGE_BODY,
      contentType: 'text/html',
    });
    fixture.page.goto.mockImplementation(async () => {
      fixture.location.href = TARGET_URL;
      fixture.location.pathname = '/sitemap.xml';
      fixture.document.title = 'Just a moment...';
      return undefined;
    });

    await expect(fetchWithBrowser(TARGET_URL)).rejects.toMatchObject({
      name: 'CloudflareError',
      retryAfterMs: 55_000,
    });
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
    now += 55_000;
    fixture.page.waitForFunction.mockImplementation(async (...args) => {
      if (args[2].timeout === 120_000) {
        fixture.document.title = '';
      }
      return waitForFunction(...args);
    });
    expect(await fetchWithBrowser(TARGET_URL)).toEqual(RESPONSE);
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});

test('a browser challenge timeout preserves the remaining cooldown in its error', async () => {
  let now = 1_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  fixture.document.title = 'Just a moment...';
  fixture.page.waitForFunction.mockImplementationOnce(async () => {
    now += 120_000;
    throw timeoutError();
  });
  try {
    await expect(fetchWithBrowser(TARGET_URL)).rejects.toMatchObject({
      name: 'CloudflareError',
      retryAfterMs: 60_000,
    });
    now += 59_999;
    await expect(fetchWithBrowser(TARGET_URL)).rejects.toMatchObject({
      name: 'CloudflareError',
      retryAfterMs: 1,
    });
    expect(fixture.page.waitForFunction).toHaveBeenCalledTimes(1);
    expect(fixture.page.evaluate).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

test('browser launch failures retain their cause rather than becoming a failed challenge', async () => {
  const cause = new Error('Browser executable missing');
  launch.mockRejectedValue(cause);
  await expect(solveCloudflare()).rejects.toMatchObject({
    name: 'FetchSetupError',
    cause,
  });
  expect(launch).toHaveBeenCalledTimes(1);
});

test('unrelated errors during solve are propagated unchanged', async () => {
  const error = new TypeError('Readiness programming error');
  fixture.page.title.mockRejectedValue(error);
  await expect(solveCloudflare()).rejects.toBe(error);
});

test('the in-page request aborts while a response body is stalled', async () => {
  await fetchWithBrowser(TARGET_URL);
  const [operation, argument] = fixture.page.evaluate.mock
    .calls[0] as unknown as [(argument: unknown) => Promise<unknown>, unknown];
  let signal: AbortSignal | undefined;
  let abort: (() => void) | undefined;
  let bodyStarted: (() => void) | undefined;
  const readingBody = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const clearTimer = mock(() => undefined);
  const request = runInNewContext(`(${operation})(argument)`, {
    argument,
    AbortController,
    setTimeout: (callback: () => void) => {
      abort = callback;
      return 123;
    },
    clearTimeout: clearTimer,
    fetch: async (_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return {
        status: 200,
        text: () =>
          new Promise((_, reject) => {
            bodyStarted!();
            signal!.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
        headers: new Headers(),
      };
    },
  }) as Promise<unknown>;
  await readingBody;
  expect(signal?.aborted).toBe(false);
  abort!();
  await expect(request).rejects.toThrow('aborted');
  expect(signal?.aborted).toBe(true);
  expect(clearTimer).toHaveBeenCalledWith(123);
});

test('a wedged page evaluation is bounded by the shared deadline and closes the page', async () => {
  fixture.page.evaluate.mockImplementation(() => new Promise(() => undefined));
  await expect(
    fetchWithBrowser(TARGET_URL, new FetchBudget(20)),
  ).rejects.toMatchObject({ name: 'FetchTimeoutError', budgetExhausted: true });
  expect(fixture.page.close).toHaveBeenCalledTimes(1);
});

test('challenge errors and solve logs omit page URLs, titles, and cookie names', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const secret = 'secret-session-value';
  fixture.document.title = secret;
  fixture.location.href = `${PIXIV_BASE_URL}?token=${secret}`;
  try {
    expect(await solveCloudflare()).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain('cf_clearance');
    fixture.page.evaluate.mockResolvedValue({
      ...RESPONSE,
      text: CHALLENGE_BODY,
      contentType: 'text/html',
    });
    try {
      await fetchWithBrowser(fixture.location.href);
      throw new Error('Expected a challenge');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain('https://');
    }
  } finally {
    log.mockRestore();
  }
});

test('cleanup closes every browser resource and surfaces failures safely', async () => {
  await fetchWithBrowser(TARGET_URL);
  const cause = new Error('Raw browser close failure with secret');
  fixture.page.close.mockRejectedValue(cause);
  await expect(closeBrowser()).rejects.toBeInstanceOf(FetchCleanupError);
  expect(fixture.context.close).toHaveBeenCalledTimes(1);
  expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  // Handles were detached before closing; the next cleanup is safe to repeat.
  await expect(closeBrowser()).resolves.toBeUndefined();
});

test('cleanup hangs are bounded and reported rather than silently succeeding', async () => {
  await fetchWithBrowser(TARGET_URL);
  fixture.context.close.mockImplementation(() => new Promise(() => undefined));
  await expect(closeBrowser(new FetchBudget(20))).rejects.toMatchObject({
    name: 'FetchCleanupError',
    cause: { name: 'AggregateError' },
  });
  expect(fixture.page.close).toHaveBeenCalledTimes(1);
  expect(fixture.browser.close).toHaveBeenCalledTimes(1);
});

test('a header-only browser challenge is rejected with a conservative cooldown', async () => {
  const response = { ...RESPONSE, cfMitigated: 'challenge' };
  fixture.page.evaluate.mockResolvedValue(response);
  await expect(fetchWithBrowser(TARGET_URL)).rejects.toMatchObject({
    name: 'CloudflareError',
    retryAfterMs: 60_000,
  });
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
});

test('a body-only HTML challenge gets a cooldown even with a normal page title', async () => {
  fixture.page.evaluate.mockResolvedValue({
    status: 403,
    text: '<html><title>Verification</title><script src="/challenge-platform"></script></html>',
    contentType: 'text/html',
  });
  await expect(fetchWithBrowser(TARGET_URL)).rejects.toMatchObject({
    name: 'CloudflareError',
    retryAfterMs: 60_000,
  });
  expect(fixture.document.title).toBe(PAGE_TITLE);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
});

test('browser JSON with quoted challenge markers is accepted without navigation', async () => {
  const response = {
    status: 200,
    text: JSON.stringify({ article: CHALLENGE_BODY }),
    contentType: 'application/json',
  };
  fixture.page.evaluate.mockResolvedValue(response);
  expect(await fetchWithBrowser(TARGET_URL)).toEqual(response);
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
  expect(fixture.page.goto).not.toHaveBeenCalled();
});

for (const kind of [
  'reload',
  'challenge',
  'unrelated',
  'subframe',
  'xhr',
  'plain403',
  'body-timeout',
]) {
  test(`navigation fallback handles ${kind} without trusting an unrelated or stale body`, async () => {
    fixture.page.evaluate.mockResolvedValue({
      ...RESPONSE,
      status: 403,
      text: CHALLENGE_BODY,
      contentType: 'text/html',
    });
    const challenge = {
      ...RESPONSE,
      status: 403,
      text: CHALLENGE_BODY,
      contentType: 'text/html',
    };
    const final =
      kind === 'challenge'
        ? challenge
        : kind === 'plain403'
          ? {
              ...RESPONSE,
              status: 403,
              text: 'Forbidden',
              contentType: 'text/plain',
            }
          : RESPONSE;
    fixture.page.goto.mockImplementation(async () => {
      fixture.location.href = TARGET_URL;
      fixture.location.pathname = '/sitemap.xml';
      const first = fixture.navigationResponse(TARGET_URL, challenge);
      fixture.emitResponse(first);
      const response = fixture.navigationResponse(
        kind === 'unrelated' ? `${PIXIV_BASE_URL}other` : TARGET_URL,
        final,
        kind !== 'subframe',
        kind !== 'xhr',
      );
      if (kind === 'body-timeout')
        response.text.mockImplementation(() => new Promise(() => undefined));
      fixture.emitResponse(response);
      return first as unknown as Response;
    });
    if (kind === 'reload' || kind === 'plain403') {
      expect(await fetchWithBrowser(TARGET_URL)).toEqual({
        ...final,
        cfMitigated: '',
      });
    } else if (kind === 'body-timeout') {
      await expect(
        fetchWithBrowser(TARGET_URL, new FetchBudget(25)),
      ).rejects.toMatchObject({
        name: 'FetchTimeoutError',
        budgetExhausted: true,
      });
      expect(fixture.page.close).toHaveBeenCalledTimes(1);
    } else {
      await expect(fetchWithBrowser(TARGET_URL)).rejects.toBeInstanceOf(
        CloudflareError,
      );
    }
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
    expect(fixture.listeners.size).toBe(0);
  });
}

test('uses a successful challenge reload after goto already returned its 403 response', async () => {
  fixture.page.evaluate.mockResolvedValue({
    ...RESPONSE,
    status: 403,
    text: CHALLENGE_BODY,
    contentType: 'text/html',
  });
  fixture.page.goto.mockImplementation(async () => {
    fixture.location.href = TARGET_URL;
    fixture.location.pathname = '/sitemap.xml';
    fixture.document.title = 'Just a moment...';
    const response = fixture.navigationResponse(TARGET_URL, {
      ...RESPONSE,
      status: 403,
      text: CHALLENGE_BODY,
      contentType: 'text/html',
    });
    fixture.emitResponse(response);
    return response as unknown as Response;
  });
  const wait = fixture.page.waitForFunction.getMockImplementation()!;
  fixture.page.waitForFunction.mockImplementation(async (...args) => {
    if (fixture.document.title === 'Just a moment...') {
      fixture.emitResponse(fixture.navigationResponse(TARGET_URL));
      fixture.document.title = '';
    }
    return wait(...args);
  });
  expect(await fetchWithBrowser(TARGET_URL)).toEqual({
    ...RESPONSE,
    cfMitigated: '',
  });
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
  expect(fixture.listeners.size).toBe(0);
});

for (const change of ['redirect', 'new-response']) {
  test(`does not reuse a target response after ${change} while reading its body`, async () => {
    fixture.page.evaluate.mockResolvedValue({
      ...RESPONSE,
      status: 403,
      text: CHALLENGE_BODY,
      contentType: 'text/html',
    });
    fixture.page.goto.mockImplementation(async () => {
      fixture.location.href = TARGET_URL;
      fixture.location.pathname = '/sitemap.xml';
      const response = fixture.navigationResponse(TARGET_URL);
      response.text.mockImplementation(async () => {
        if (change === 'redirect')
          fixture.location.href = `${PIXIV_BASE_URL}other`;
        else fixture.emitResponse(fixture.navigationResponse(TARGET_URL));
        return RESPONSE.text;
      });
      fixture.emitResponse(response);
      return response as unknown as Response;
    });
    await expect(fetchWithBrowser(TARGET_URL)).rejects.toBeInstanceOf(
      CloudflareError,
    );
    expect(fixture.listeners.size).toBe(0);
  });
}

test('navigation response headers remain authoritative even with a harmless body and title', async () => {
  fixture.page.evaluate.mockResolvedValue({
    ...RESPONSE,
    status: 403,
    text: CHALLENGE_BODY,
    contentType: 'text/html',
  });
  fixture.page.goto.mockImplementation(async () => {
    fixture.location.href = TARGET_URL;
    fixture.location.pathname = '/sitemap.xml';
    const response = fixture.navigationResponse(TARGET_URL);
    response.allHeaders.mockResolvedValue({
      'content-type': 'application/xml',
      'cf-mitigated': 'challenge',
    } as { 'content-type': string });
    fixture.emitResponse(response);
    return response as unknown as Response;
  });
  await expect(fetchWithBrowser(TARGET_URL)).rejects.toMatchObject({
    name: 'CloudflareError',
    retryAfterMs: 60_000,
  });
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(1);
  expect(fixture.listeners.size).toBe(0);
});
