import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as wreq from 'wreq-js';
import * as browser from '../fetch/solveCloudflare';
import { closeSession, fetchURL } from '../fetch/fetchURL';
import {
  CloudflareError,
  HttpError,
  FetchTimeoutError,
  FetchSetupError,
  FetchCleanupError,
  isTransientFetchError,
} from '../fetch/errors';
import { FetchBudget } from '../fetch/budget';

const TARGET_URL = 'https://dic.pixiv.net/_api/get_article/example';
const CHALLENGE_BODY =
  '<html><title>Just a moment...</title><script src="/challenge-platform"></script></html>';
const BROWSER_RESPONSE = {
  status: 200,
  text: '{"tag_name":"example"}',
  contentType: 'application/json',
};
const originalSetTimeout = globalThis.setTimeout;

function makeFixture() {
  const fetch = mock(async () => ({
    status: 403,
    text: async () => CHALLENGE_BODY,
    headers: new Headers({ 'content-type': 'text/html' }),
  }));
  const close = mock(async () => undefined);
  return { fetch, close, closed: false };
}

let fixture: ReturnType<typeof makeFixture>;
let createSession: ReturnType<typeof spyOn<typeof wreq, 'createSession'>>;
let solveCloudflare: ReturnType<
  typeof spyOn<typeof browser, 'solveCloudflare'>
>;
let fetchWithBrowser: ReturnType<
  typeof spyOn<typeof browser, 'fetchWithBrowser'>
>;
let closeBrowser: ReturnType<typeof spyOn<typeof browser, 'closeBrowser'>>;
let timer: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>;
let sleeps: ReturnType<typeof spyOn<FetchBudget, 'sleep'>>;
let random: ReturnType<typeof spyOn<typeof Math, 'random'>>;

beforeEach(() => {
  sleeps = spyOn(FetchBudget.prototype, 'sleep');
  random = spyOn(Math, 'random').mockReturnValue(0);
  fixture = makeFixture();
  createSession = spyOn(wreq, 'createSession').mockResolvedValue(
    fixture as unknown as wreq.Session,
  );
  solveCloudflare = spyOn(browser, 'solveCloudflare').mockResolvedValue(true);
  fetchWithBrowser = spyOn(browser, 'fetchWithBrowser').mockResolvedValue(
    BROWSER_RESPONSE,
  );
  closeBrowser = spyOn(browser, 'closeBrowser').mockResolvedValue(undefined);
  // Record retry delays without waiting or contacting the live site.
  const immediateTimer = (
    ...[callback, , ...args]: Parameters<typeof setTimeout>
  ) => originalSetTimeout(callback, 0, ...args);
  timer = spyOn(globalThis, 'setTimeout').mockImplementation(
    Object.assign(immediateTimer, {
      __promisify__: originalSetTimeout.__promisify__,
    }),
  );
});

afterEach(async () => {
  try {
    await closeSession();
  } finally {
    // Restore every spy so the existing live integration uses real clients.
    createSession.mockRestore();
    solveCloudflare.mockRestore();
    fetchWithBrowser.mockRestore();
    closeBrowser.mockRestore();
    timer.mockRestore();
    sleeps.mockRestore();
    random.mockRestore();
  }
});

for (const successfulAttempt of [1, 2, 3]) {
  test(`fetches the requested URL when the handshake succeeds on attempt ${successfulAttempt}`, async () => {
    for (let attempt = 1; attempt < successfulAttempt; attempt++) {
      solveCloudflare.mockResolvedValueOnce(false);
    }

    expect(await fetchURL(TARGET_URL)).toEqual({
      status: 200,
      data: { tag_name: 'example' },
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(successfulAttempt);
    expect(solveCloudflare).toHaveBeenCalledTimes(successfulAttempt);
    expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
    expect(fetchWithBrowser).toHaveBeenCalledWith(
      TARGET_URL,
      expect.any(FetchBudget),
    );
    expect(sleeps.mock.calls.map((call) => call[0])).toEqual(
      [5000, 15_000].slice(0, successfulAttempt - 1),
    );

    // Successful handoff is retained for the next queued request.
    const nextUrl = `${TARGET_URL}/next`;
    expect(await fetchURL(nextUrl)).toEqual({
      status: 200,
      data: { tag_name: 'example' },
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(successfulAttempt);
    expect(solveCloudflare).toHaveBeenCalledTimes(successfulAttempt);
    expect(fetchWithBrowser).toHaveBeenLastCalledWith(
      nextUrl,
      expect.any(FetchBudget),
    );
    expect(fetchWithBrowser).toHaveBeenCalledTimes(2);
  });
}

test('exhausts three failed handshakes without a browser fetch', async () => {
  solveCloudflare.mockResolvedValue(false);

  await expect(fetchURL(TARGET_URL)).rejects.toBeInstanceOf(CloudflareError);
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  expect(solveCloudflare).toHaveBeenCalledTimes(3);
  expect(fetchWithBrowser).not.toHaveBeenCalled();
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([5000, 15_000]);
});

test('bounds persistent browser challenge responses to three attempts', async () => {
  fetchWithBrowser.mockResolvedValue({
    status: 403,
    text: CHALLENGE_BODY,
    contentType: 'text/html',
  });

  await expect(fetchURL(TARGET_URL)).rejects.toBeInstanceOf(CloudflareError);
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(solveCloudflare).toHaveBeenCalledTimes(1);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(3);
});

test('preserves a browser challenge error after a final-attempt handshake', async () => {
  const error = new CloudflareError('Browser still has a challenge');
  solveCloudflare.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  fetchWithBrowser.mockRejectedValue(error);

  await expect(fetchURL(TARGET_URL)).rejects.toBe(error);
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  expect(solveCloudflare).toHaveBeenCalledTimes(3);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
});

test('preserves an unrelated browser error after a final-attempt handshake', async () => {
  const error = new TypeError('page.evaluate: Failed to fetch');
  solveCloudflare.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  fetchWithBrowser.mockRejectedValue(error);

  await expect(fetchURL(TARGET_URL)).rejects.toBe(error);
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  expect(solveCloudflare).toHaveBeenCalledTimes(3);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
});

for (const status of [404, 500]) {
  test(`preserves HTTP ${status} after a final-attempt handshake`, async () => {
    solveCloudflare.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    fetchWithBrowser.mockResolvedValue({
      status,
      text: 'Request failed',
      contentType: 'text/plain',
    });

    await expect(fetchURL(TARGET_URL)).rejects.toMatchObject({
      name: 'HttpError',
      status,
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(solveCloudflare).toHaveBeenCalledTimes(3);
    expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
  });
}

test('retries browser HTTP 429 within the three-attempt limit', async () => {
  fetchWithBrowser.mockResolvedValueOnce({
    status: 429,
    text: 'Too many requests',
    contentType: 'text/plain',
  });

  expect(await fetchURL(TARGET_URL)).toEqual({
    status: 200,
    data: { tag_name: 'example' },
  });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(solveCloudflare).toHaveBeenCalledTimes(1);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(2);
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([20_000]);
});

test('stops after three browser HTTP 429 responses', async () => {
  fetchWithBrowser.mockResolvedValue({
    status: 429,
    text: 'Too many requests',
    contentType: 'text/plain',
  });

  await expect(fetchURL(TARGET_URL)).rejects.toMatchObject({
    name: 'HttpError',
    status: 429,
  });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(solveCloudflare).toHaveBeenCalledTimes(1);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(3);
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([20_000, 20_000]);
});

test('does not add a fourth attempt for HTTP 429 after the final handshake', async () => {
  solveCloudflare.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  fetchWithBrowser.mockResolvedValue({
    status: 429,
    text: 'Too many requests',
    contentType: 'text/plain',
  });

  await expect(fetchURL(TARGET_URL)).rejects.toMatchObject({
    name: 'HttpError',
    status: 429,
  });
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  expect(solveCloudflare).toHaveBeenCalledTimes(3);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([5000, 15_000]);
});

test('preserves non-JSON browser response data and status', async () => {
  fetchWithBrowser.mockResolvedValue({
    status: 201,
    text: '<sitemapindex></sitemapindex>',
    contentType: 'application/xml',
  });

  expect(await fetchURL(TARGET_URL)).toEqual({
    status: 201,
    data: '<sitemapindex></sitemapindex>',
  });
  expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
});

test('ordinary HTTP 404 responses still fail without a browser handshake', async () => {
  fixture.fetch.mockResolvedValue({
    status: 404,
    text: async () => 'Not found',
    headers: new Headers(),
  });

  await expect(fetchURL(TARGET_URL)).rejects.toBeInstanceOf(HttpError);
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(solveCloudflare).not.toHaveBeenCalled();
  expect(fetchWithBrowser).not.toHaveBeenCalled();
});

test('waits out the challenge cooldown before spending the final browser attempt', async () => {
  solveCloudflare.mockResolvedValueOnce(false);
  fetchWithBrowser.mockRejectedValueOnce(
    new CloudflareError('Sitemap challenge is still cooling down', 55_000),
  );

  expect(await fetchURL(TARGET_URL)).toEqual({
    status: 200,
    data: { tag_name: 'example' },
  });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  expect(solveCloudflare).toHaveBeenCalledTimes(2);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(2);
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([5000, 55_000]);
  expect(closeBrowser).not.toHaveBeenCalled();
});

test('backs off browser failures without sleeping after the final attempt', async () => {
  const error = new CloudflareError('Persistent challenge', 60_000);
  fetchWithBrowser.mockRejectedValue(error);

  await expect(fetchURL(TARGET_URL)).rejects.toBe(error);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(3);
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([60_000, 60_000]);
});

test('uses bounded backoff for unhinted browser errors', async () => {
  const error = new TypeError('page.evaluate: Failed to fetch');
  fetchWithBrowser.mockRejectedValue(error);

  await expect(fetchURL(TARGET_URL)).rejects.toBe(error);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(3);
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([5000, 15_000]);
});

test('a smaller cooldown hint does not shorten ordinary browser backoff', async () => {
  fetchWithBrowser.mockRejectedValueOnce(new CloudflareError('Challenge', 1));

  expect(await fetchURL(TARGET_URL)).toEqual({
    status: 200,
    data: { tag_name: 'example' },
  });
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([5000]);
});

test('a hinted failure on the final handoff adds neither a sleep nor an attempt', async () => {
  solveCloudflare.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  const error = new CloudflareError('Still challenged', 180_000);
  fetchWithBrowser.mockRejectedValue(error);

  await expect(fetchURL(TARGET_URL)).rejects.toBe(error);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
  expect(sleeps.mock.calls.map((call) => call[0])).toEqual([5000, 15_000]);
});

for (const error of [
  new SyntaxError('Malformed API JSON'),
  new TypeError('Unexpected article shape'),
  Object.assign(new Error('Schema assertion failed'), {
    name: 'AssertionError',
  }),
  new Error('Unknown programming failure'),
]) {
  test(`does not retry ${error.name} from the browser`, async () => {
    fetchWithBrowser.mockRejectedValue(error);
    await expect(fetchURL(TARGET_URL)).rejects.toBe(error);
    expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
  });
}

test('malformed declared JSON is fatal without recreating the HTTP client', async () => {
  fixture.fetch.mockResolvedValue({
    status: 200,
    text: async () => '{"secret":',
    headers: new Headers({ 'content-type': 'application/json' }),
  });
  await expect(fetchURL(TARGET_URL)).rejects.toBeInstanceOf(SyntaxError);
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(fixture.close).not.toHaveBeenCalled();
  expect(sleeps).not.toHaveBeenCalled();
});

test('client setup errors retain their cause and are never retried', async () => {
  const cause = Object.assign(new Error('Native module unavailable'), {
    name: 'TimeoutError',
  });
  createSession.mockRejectedValue(cause);
  await expect(fetchURL(TARGET_URL)).rejects.toMatchObject({
    name: 'FetchSetupError',
    cause,
  });
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(sleeps).not.toHaveBeenCalled();
});

test('a budget that cannot fit the cooldown does not spend another attempt', async () => {
  fetchWithBrowser.mockRejectedValue(
    new CloudflareError('Cooling down', 180_000),
  );
  await expect(
    fetchURL(TARGET_URL, new FetchBudget(100_000)),
  ).rejects.toMatchObject({ name: 'FetchTimeoutError', budgetExhausted: true });
  expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
  expect(sleeps).toHaveBeenCalledWith(180_000);
});

test('the same budget includes transport work, browser handoff, and retries', async () => {
  let now = 1_000_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const budget = new FetchBudget(20_000);
  solveCloudflare.mockImplementation(async (received) => {
    expect(received).toBe(budget);
    now += 16_000;
    return true;
  });
  fetchWithBrowser.mockRejectedValue(new CloudflareError());
  try {
    await expect(fetchURL(TARGET_URL, budget)).rejects.toBeInstanceOf(
      FetchTimeoutError,
    );
    expect(fetchWithBrowser).toHaveBeenCalledWith(TARGET_URL, budget);
    expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

test('aborts a hanging HTTP request when its shared budget expires', async () => {
  timer.mockRestore();
  let signal: AbortSignal | undefined;
  fixture.fetch.mockImplementation((...args: unknown[]) => {
    signal = (args[1] as { signal: AbortSignal }).signal;
    return new Promise(() => undefined);
  });
  await expect(fetchURL(TARGET_URL, new FetchBudget(20))).rejects.toMatchObject(
    { name: 'FetchTimeoutError', budgetExhausted: true },
  );
  expect(signal?.aborted).toBe(true);
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});

test('uses jitter while retaining the minimum retry delay', async () => {
  random.mockReturnValue(0.5);
  fetchWithBrowser.mockRejectedValueOnce(new CloudflareError());
  await fetchURL(TARGET_URL);
  expect(sleeps).toHaveBeenCalledWith(5500);
});

test('diagnostics never contain request URLs, query strings, or raw error text', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const secret = 'private-token-in-query';
  fetchWithBrowser.mockRejectedValueOnce(
    new CloudflareError(`secret body ${secret}`),
  );
  try {
    await fetchURL(`${TARGET_URL}?token=${secret}`);
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain(secret);
    expect(output).not.toContain('https://');
    expect(output).not.toContain('secret body');
    expect(output).toContain('category=cloudflare');
  } finally {
    log.mockRestore();
  }
});

test('classifies known transport failures without retrying validation or TLS setup failures', () => {
  const wreqError = (message: string) =>
    Object.assign(new TypeError(message), { name: 'RequestError' });
  for (const error of [
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    }),
    wreqError(
      'Error: GET http://127.0.0.1:1: error sending request for uri (http://127.0.0.1:1/): tcp connect error: Connection refused (os error 111)',
    ),
    wreqError(
      'Error: GET http://127.0.0.1:1: error sending request for uri (http://127.0.0.1:1/): operation timed out: operation timed out',
    ),
    new HttpError(503, 'Unavailable'),
  ])
    expect(isTransientFetchError(error)).toBe(true);
  for (const error of [
    wreqError('Invalid browser profile'),
    wreqError(
      'Error: GET https://example.test: error sending request for uri (https://example.test/): certificate verify failed',
    ),
    new TypeError('Unexpected article shape'),
    new FetchSetupError(new Error('Timeout')),
    new HttpError(403, 'Forbidden'),
    new FetchTimeoutError(true),
  ])
    expect(isTransientFetchError(error)).toBe(false);
});

test('session cleanup errors do not prevent browser cleanup and remain observable', async () => {
  await fetchURL(TARGET_URL);
  const cause = new Error('Native close failed');
  fixture.close.mockRejectedValue(cause);
  await expect(closeSession()).rejects.toBeInstanceOf(FetchCleanupError);
  expect(closeBrowser).toHaveBeenCalledTimes(1);
  await expect(closeSession()).resolves.toBeUndefined();
});

test('session cleanup has its own bounded grace period', async () => {
  await fetchURL(TARGET_URL);
  timer.mockRestore();
  fixture.close.mockImplementation(() => new Promise(() => undefined));
  await expect(closeSession(new FetchBudget(20))).rejects.toMatchObject({
    name: 'FetchCleanupError',
    cause: { name: 'FetchTimeoutError', budgetExhausted: true },
  });
  expect(closeBrowser).toHaveBeenCalledTimes(1);
});

test('recognizes an HTTP 200 challenge title without a challenge-platform marker', async () => {
  fixture.fetch.mockResolvedValue({
    status: 200,
    text: async () => '<html><title>Just a moment...</title></html>',
    headers: new Headers({ 'content-type': 'text/html' }),
  });
  expect(await fetchURL(TARGET_URL)).toEqual({
    status: 200,
    data: { tag_name: 'example' },
  });
  expect(solveCloudflare).toHaveBeenCalledTimes(1);
  expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
});
