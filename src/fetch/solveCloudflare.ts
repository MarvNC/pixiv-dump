import { PIXIV_BASE_URL } from '../constants';

type PlaywrightBrowser = import('playwright').Browser;
type PlaywrightContext = import('playwright').BrowserContext;
type PlaywrightPage = import('playwright').Page;

let browser: PlaywrightBrowser | null = null;
let context: PlaywrightContext | null = null;
let page: PlaywrightPage | null = null;
let launchPromise: Promise<PlaywrightContext> | null = null;
let lastChallengeWaitMs = 0;

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

async function waitForChallengeClear(p: PlaywrightPage): Promise<void> {
  const title = await p.title().catch(() => '');
  if (!isChallengeTitle(title)) {
    return;
  }
  if (Date.now() - lastChallengeWaitMs < 180_000) {
    return;
  }
  lastChallengeWaitMs = Date.now();
  await p.waitForFunction(
    () => {
      const t = document.title;
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

async function ensureClearedPage(): Promise<PlaywrightPage> {
  const p = await getPage();
  const title = await p.title().catch(() => '');
  const onSite = p.url().startsWith(PIXIV_BASE_URL);
  if (onSite && !isChallengeTitle(title) && (await hasPixivSession())) {
    return p;
  }
  if (!onSite) {
    await p.goto(PIXIV_BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
  }
  await waitForChallengeClear(p);
  await waitForPixivSession(15_000);
  return p;
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
    const p = await ensureClearedPage();
    const names = await cookieNames();
    const title = await p.title().catch(() => '');
    const ready = await hasPixivSession();
    console.log(
      `Cloudflare browser solve ${ready ? 'ok' : 'not ready'} title=${JSON.stringify(
        title,
      )} cookies=${names.join(', ')} page=${p.url()}`,
    );
    return ready;
  } catch (error) {
    if (await hasPixivSession()) {
      console.log(
        'Cloudflare browser solve timed out but pixiv session is set',
      );
      return true;
    }
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
  const p = await ensureClearedPage();
  let result = await pageFetch(p, url);
  if (isChallengeBody(result.text)) {
    await p.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await waitForChallengeClear(p);
    result = await pageFetch(p, url);
  }
  if (isChallengeBody(result.text)) {
    throw new Error(`Cloudflare challenge body for ${url}`);
  }
  return result;
}

export async function closeBrowser(): Promise<void> {
  lastChallengeWaitMs = 0;
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
