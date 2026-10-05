import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as wreq from 'wreq-js';
import * as browser from '../fetch/solveCloudflare';
import { closeSession, fetchURL } from '../fetch/fetchURL';
import { CloudflareError, HttpError } from '../fetch/errors';

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

beforeEach(() => {
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
    expect(fetchWithBrowser).toHaveBeenCalledWith(TARGET_URL);
    expect(timer.mock.calls.map((call) => call[1])).toEqual(
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
    expect(fetchWithBrowser).toHaveBeenLastCalledWith(nextUrl);
    expect(fetchWithBrowser).toHaveBeenCalledTimes(2);
  });
}

test('exhausts three failed handshakes without a browser fetch', async () => {
  solveCloudflare.mockResolvedValue(false);

  await expect(fetchURL(TARGET_URL)).rejects.toBeInstanceOf(CloudflareError);
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  expect(solveCloudflare).toHaveBeenCalledTimes(3);
  expect(fetchWithBrowser).not.toHaveBeenCalled();
  expect(timer.mock.calls.map((call) => call[1])).toEqual([
    5000, 15_000, 45_000,
  ]);
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
  expect(timer.mock.calls.map((call) => call[1])).toEqual([20_000]);
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
  expect(timer.mock.calls.map((call) => call[1])).toEqual([
    20_000, 20_000, 20_000,
  ]);
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
  expect(timer.mock.calls.map((call) => call[1])).toEqual([
    5000, 15_000, 20_000,
  ]);
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
