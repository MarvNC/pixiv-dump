import { PIXIV_BASE_URL } from '../constants';
import { CloudflareError } from './errors';

type PlaywrightBrowser = import('playwright').Browser;
type PlaywrightContext = import('playwright').BrowserContext;
type PlaywrightPage = import('playwright').Page;

const PAGE_READY_TIMEOUT_MS = 15_000;
const MAX_NAVIGATION_ATTEMPTS = 3;
const CHALLENGE_WAIT_COOLDOWN_MS = 180_000;

let browser: PlaywrightBrowser | null = null;
let context: PlaywrightContext | null = null;
let page: PlaywrightPage | null = null;
let launchPromise: Promise<PlaywrightContext> | null = null;
let lastChallengeWaitMs: number | null = null;

function browserChallengeError(message: string): CloudflareError {
  const retryAfterMs =
    lastChallengeWaitMs === null
      ? 0
      : Math.max(
          0,
          Math.min(
            CHALLENGE_WAIT_COOLDOWN_MS,
            CHALLENGE_WAIT_COOLDOWN_MS - (Date.now() - lastChallengeWaitMs),
          ),
        );
  return new CloudflareError(message, retryAfterMs);
}

async function getContext(): Promise<PlaywrightContext> {
  if (context) {
    return context;
  }
  if (!launchPromise) {
    launchPromise = (async () => {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({
        headless: !process.env.DISPLAY,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      context = await browser.newContext({
        locale: 'ja-JP',
      });
      return context;
    })().catch((error) => {
      launchPromise = null;
      throw error;
    });
  }
  return launchPromise;
}

async function getPage(): Promise<PlaywrightPage> {
  if (page && !page.isClosed()) {
    return page;
  }
  const ctx = await getContext();
  page = await ctx.newPage();
  return page;
}

async function cookieNames(): Promise<string[]> {
  if (!context) {
    return [];
  }
  return (await context.cookies()).map((cookie) => cookie.name);
}

async function hasPixivSession(): Promise<boolean> {
  const names = await cookieNames();
  return names.includes('cf_clearance') || names.includes('pixpsession2');
}

function isChallengeTitle(title: string): boolean {
  return (
    /just a moment/i.test(title) ||
    /しばらくお待ちください/.test(title) ||
    /attention required/i.test(title) ||
    /access denied/i.test(title) ||
    /you have been blocked/i.test(title)
  );
}

function isChallengeBody(text: string): boolean {
  return (
    /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(text) ||
    /<title>\s*しばらくお待ちください/.test(text) ||
    /challenge-platform/i.test(text)
  );
}

export function throwIfChallengeBody(url: string, text: string): void {
  if (isChallengeBody(text)) {
    throw browserChallengeError(`Cloudflare challenge body for ${url}`);
  }
}

async function waitForChallengeClear(p: PlaywrightPage): Promise<void> {
  const title = await p.title();
  if (!isChallengeTitle(title)) {
    return;
  }
  const cooldownError = browserChallengeError(
    `Cloudflare browser challenge for ${p.url()}`,
  );
  if (cooldownError.retryAfterMs > 0) {
    // Do not spend a fetch attempt checking the same blocked page immediately.
    throw cooldownError;
  }
  lastChallengeWaitMs = Date.now();
  await p.waitForFunction(
    () => {
      const t = (globalThis as unknown as { document: { title: string } })
        .document.title;
      return !/just a moment/i.test(t) && !/しばらくお待ちください/.test(t);
    },
    null,
    { timeout: 120_000 },
  );
}

async function waitForPixivSession(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasPixivSession()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return hasPixivSession();
}

async function waitForReadyPage(p: PlaywrightPage): Promise<void> {
  await p.waitForLoadState('domcontentloaded', {
    timeout: PAGE_READY_TIMEOUT_MS,
  });
  const ready = await p.waitForFunction(
    (baseUrl) => {
      const { document, location } = globalThis as unknown as {
        document: { title: string; readyState: string };
        location: { href: string; pathname: string };
      };
      // A clearance cookie may precede the navigation to the real document.
      // JSON/XML fallback pages can legitimately have no title; the homepage cannot.
      return (
        location.href.startsWith(baseUrl) &&
        document.readyState !== 'loading' &&
        (document.title.trim() !== '' || location.pathname !== '/') &&
        !/^\s*Loading(?:\s|$)/i.test(document.title)
      );
    },
    PIXIV_BASE_URL,
    { timeout: PAGE_READY_TIMEOUT_MS },
  );
  await ready.dispose();
  if (isChallengeTitle(await p.title())) {
    throw browserChallengeError(`Cloudflare browser challenge for ${p.url()}`);
  }
}

async function retryAfterNavigation<T>(
  p: PlaywrightPage,
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= MAX_NAVIGATION_ATTEMPTS ||
        p.isClosed() ||
        !(error instanceof Error) ||
        !/Execution context was destroyed|Cannot find context with specified id/.test(
          error.message,
        )
      ) {
        throw error;
      }
      // Readiness and evaluate cannot be atomic. Let an in-flight navigation
      // settle, then recheck the page before retrying this read-only fetch.
      await p.waitForLoadState('domcontentloaded', {
        timeout: PAGE_READY_TIMEOUT_MS,
      });
      await p.waitForTimeout(250);
    }
  }
}

async function ensureClearedPage(p: PlaywrightPage): Promise<void> {
  if (!p.url().startsWith(PIXIV_BASE_URL)) {
    await p.goto(PIXIV_BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
  }
  await waitForChallengeClear(p);
  await waitForPixivSession(15_000);
  await waitForReadyPage(p);
}

async function pageFetch(
  p: PlaywrightPage,
  url: string,
): Promise<{ status: number; text: string; contentType: string }> {
  return p.evaluate(async (target) => {
    const res = await fetch(target, { credentials: 'include' });
    return {
      status: res.status,
      text: await res.text(),
      contentType: res.headers.get('content-type') || '',
    };
  }, url);
}

export async function solveCloudflare(): Promise<boolean> {
  try {
    const p = await getPage();
    return await retryAfterNavigation(p, async () => {
      await ensureClearedPage(p);
      const names = await cookieNames();
      const title = await p.title();
      const url = p.url();
      const ready =
        url.startsWith(PIXIV_BASE_URL) &&
        !isChallengeTitle(title) &&
        !/^\s*Loading(?:\s|$)/i.test(title) &&
        (title.trim() !== '' || new URL(url).pathname !== '/') &&
        (await hasPixivSession());
      console.log(
        `Cloudflare browser solve ${ready ? 'ok' : 'not ready'} title=${JSON.stringify(
          title,
        )} cookies=${names.join(', ')} page=${url}`,
      );
      return ready;
    });
  } catch (error) {
    const p = page && !page.isClosed() ? page : null;
    const title = p ? await p.title().catch(() => '') : '';
    const url = p ? p.url() : '';
    console.error(
      `Cloudflare browser solve failed: ${error} title=${JSON.stringify(title)} page=${url}`,
    );
    return false;
  }
}

export async function fetchWithBrowser(url: string): Promise<{
  status: number;
  text: string;
  contentType: string;
}> {
  try {
    const p = await getPage();
    return await retryAfterNavigation(p, async () => {
      await ensureClearedPage(p);
      let result = await pageFetch(p, url);
      if (isChallengeBody(result.text)) {
        await p.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        await waitForChallengeClear(p);
        await waitForReadyPage(p);
        result = await pageFetch(p, url);
      }
      throwIfChallengeBody(url, result.text);
      return result;
    });
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    const p = page && !page.isClosed() ? page : null;
    const title = p ? await p.title().catch(() => '') : '';
    if (isChallengeTitle(title)) {
      throw browserChallengeError(`Cloudflare browser challenge for ${url}`);
    }
    throw error;
  }
}

export async function closeBrowser(): Promise<void> {
  lastChallengeWaitMs = null;
  launchPromise = null;
  const currentPage = page;
  const currentContext = context;
  const currentBrowser = browser;
  page = null;
  context = null;
  browser = null;
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.close().catch(() => undefined);
  }
  if (currentContext) {
    await currentContext.close().catch(() => undefined);
  }
  if (currentBrowser) {
    await currentBrowser.close().catch(() => undefined);
  }
}
