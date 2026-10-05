import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { chromium, type Browser } from 'playwright';
import { PIXIV_BASE_URL } from '../constants';
import { CloudflareError } from '../fetch/errors';
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
  const page = {
    isClosed: () => closed,
    url: () => location.href,
    title: mock(async () => document.title),
    goto: mock(async () => undefined),
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
  return { document, location, page, context, browser };
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

  expect(await solveCloudflare()).toBe(false);
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

    expect(await solveCloudflare()).toBe(false);
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
  });

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBeInstanceOf(
    CloudflareError,
  );
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(2);
  expect(fixture.page.goto).toHaveBeenCalledTimes(1);
});

test('a navigation retry does not turn a persistent challenge into success', async () => {
  fixture.page.evaluate
    .mockRejectedValueOnce(navigationError())
    .mockResolvedValue({ ...RESPONSE, text: CHALLENGE_BODY });

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBeInstanceOf(
    CloudflareError,
  );
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(3);
});

test('accepts an untitled JSON document after the challenge-response fallback', async () => {
  fixture.page.evaluate
    .mockResolvedValueOnce({ ...RESPONSE, text: CHALLENGE_BODY })
    .mockResolvedValue({
      status: 200,
      text: '{}',
      contentType: 'application/json',
    });
  fixture.page.goto.mockImplementation(async () => {
    fixture.location.href = `${PIXIV_BASE_URL}_api/get_article/example`;
    fixture.location.pathname = '/_api/get_article/example';
    fixture.document.title = '';
  });

  expect(await fetchWithBrowser(fixture.location.href)).toEqual({
    status: 200,
    text: '{}',
    contentType: 'application/json',
  });
  expect(fixture.page.evaluate).toHaveBeenCalledTimes(2);
  // The same untitled document must also be reusable for the next fetch.
  expect(await fetchWithBrowser(TARGET_URL)).toEqual({
    status: 200,
    text: '{}',
    contentType: 'application/json',
  });
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
  expect(fixture.page.waitForTimeout).toHaveBeenCalledTimes(1);
});

test('unrelated title errors are not hidden by session cookies', async () => {
  const error = new Error('page.title: unexpected browser error');
  fixture.page.title.mockRejectedValueOnce(error);

  await expect(fetchWithBrowser(TARGET_URL)).rejects.toBe(error);
  expect(fixture.page.evaluate).not.toHaveBeenCalled();
});

test('an empty homepage title is not ready', async () => {
  fixture.document.title = '';

  expect(await solveCloudflare()).toBe(false);
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
