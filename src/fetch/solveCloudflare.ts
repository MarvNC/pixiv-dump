import { PIXIV_BASE_URL } from '../constants';
import { FetchBudget, REQUEST_TIMEOUT_MS } from './budget';
import {
  CloudflareError,
  FetchSetupError,
  FetchTimeoutError,
  FetchCleanupError,
} from './errors';

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
let browserGeneration = 0;
let lastChallengeWaitMs: number | null = null;

function browserChallengeError(
  message = 'Cloudflare browser challenge',
): CloudflareError {
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

async function getContext(budget: FetchBudget): Promise<PlaywrightContext> {
  if (context) return context;
  if (!launchPromise) {
    const generation = browserGeneration;
    let startingBrowser: PlaywrightBrowser | null = null;
    launchPromise = budget
      .run(async (timeout) => {
        const { chromium } = await import('playwright');
        startingBrowser = await chromium.launch({
          headless: !process.env.DISPLAY,
          timeout,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
          ],
        });
        if (generation !== browserGeneration || budget.remainingMs() === 0) {
          void startingBrowser.close().catch(() => undefined);
          throw new FetchTimeoutError(true);
        }
        const created = await startingBrowser.newContext({ locale: 'ja-JP' });
        if (generation !== browserGeneration || budget.remainingMs() === 0) {
          void startingBrowser.close().catch(() => undefined);
          throw new FetchTimeoutError(true);
        }
        browser = startingBrowser;
        context = created;
        return created;
      }, REQUEST_TIMEOUT_MS)
      .catch((error) => {
        browserGeneration++;
        launchPromise = null;
        if (startingBrowser)
          void startingBrowser.close().catch(() => undefined);
        if (error instanceof FetchTimeoutError && error.budgetExhausted)
          throw error;
        throw new FetchSetupError(error);
      });
  }
  return launchPromise;
}

async function getPage(budget: FetchBudget): Promise<PlaywrightPage> {
  if (page && !page.isClosed()) return page;
  const ctx = await getContext(budget);
  const generation = browserGeneration;
  const created = await budget.run(async () => {
    const created = await ctx.newPage();
    if (generation !== browserGeneration || budget.remainingMs() === 0) {
      void created.close().catch(() => undefined);
      throw new FetchTimeoutError(true);
    }
    return created;
  });
  page = created;
  return created;
}

async function hasPixivSession(budget: FetchBudget): Promise<boolean> {
  if (!context) return false;
  const cookies = await budget.run(() => context!.cookies());
  return cookies.some(
    ({ name }) => name === 'cf_clearance' || name === 'pixpsession2',
  );
}

function isChallengeTitle(title: string): boolean {
  return /just a moment|しばらくお待ちください|attention required|access denied|you have been blocked/i.test(
    title,
  );
}

function isChallengeBody(text: string): boolean {
  return (
    /<title>\s*Just a moment\.+\s*<\/title>/i.test(text) ||
    /<title>\s*しばらくお待ちください/.test(text) ||
    /challenge-platform/i.test(text)
  );
}

export function throwIfChallengeBody(_url: string, text: string): void {
  if (isChallengeBody(text))
    throw browserChallengeError('Cloudflare challenge response');
}

async function waitForChallengeClear(
  p: PlaywrightPage,
  budget: FetchBudget,
): Promise<void> {
  if (!isChallengeTitle(await budget.run(() => p.title()))) return;
  const cooldownError = browserChallengeError();
  if (cooldownError.retryAfterMs > 0) throw cooldownError;
  lastChallengeWaitMs = Date.now();
  try {
    const ready = await budget.run(
      (timeout) =>
        p.waitForFunction(
          () => {
            const title = (
              globalThis as unknown as { document: { title: string } }
            ).document.title;
            return !/just a moment|しばらくお待ちください|attention required|access denied|you have been blocked/i.test(
              title,
            );
          },
          null,
          { timeout },
        ),
      120_000,
    );
    await budget.run(() => ready.dispose());
  } catch (error) {
    // Only a known challenge wait timeout is a challenge failure. Parser,
    // assertion, launch, and unrelated page errors must retain their identity.
    if (
      (error instanceof FetchTimeoutError && !error.budgetExhausted) ||
      (error instanceof Error && error.name === 'TimeoutError')
    ) {
      throw browserChallengeError();
    }
    throw error;
  }
}

async function waitForPixivSession(budget: FetchBudget): Promise<void> {
  const deadline = Date.now() + Math.min(15_000, budget.timeout());
  while (Date.now() < deadline) {
    if (await hasPixivSession(budget)) return;
    await budget.sleep(Math.min(500, deadline - Date.now()));
  }
}

async function waitForReadyPage(
  p: PlaywrightPage,
  budget: FetchBudget,
): Promise<void> {
  await budget.run(
    (timeout) => p.waitForLoadState('domcontentloaded', { timeout }),
    PAGE_READY_TIMEOUT_MS,
  );
  const ready = await budget.run(
    (timeout) =>
      p.waitForFunction(
        (baseUrl) => {
          const { document, location } = globalThis as unknown as {
            document: { title: string; readyState: string };
            location: { href: string; pathname: string };
          };
          // Cookies may precede navigation. Untitled JSON/XML pages are valid;
          // an untitled or loading homepage is not a ready document.
          return (
            location.href.startsWith(baseUrl) &&
            document.readyState !== 'loading' &&
            (document.title.trim() !== '' || location.pathname !== '/') &&
            !/^\s*Loading(?:\s|$)/i.test(document.title)
          );
        },
        PIXIV_BASE_URL,
        { timeout },
      ),
    PAGE_READY_TIMEOUT_MS,
  );
  await budget.run(() => ready.dispose());
  if (isChallengeTitle(await budget.run(() => p.title())))
    throw browserChallengeError();
}

async function retryAfterNavigation<T>(
  p: PlaywrightPage,
  budget: FetchBudget,
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    budget.timeout();
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= MAX_NAVIGATION_ATTEMPTS ||
        p.isClosed() ||
        !(error instanceof Error) ||
        error.name === 'AssertionError' ||
        !/^page\.(?:evaluate|title|waitForFunction): (?:Execution context was destroyed|Cannot find context with specified id)/.test(
          error.message,
        )
      )
        throw error;
      await budget.run(
        (timeout) => p.waitForLoadState('domcontentloaded', { timeout }),
        PAGE_READY_TIMEOUT_MS,
      );
      await budget.sleep(250);
    }
  }
}

async function ensureClearedPage(
  p: PlaywrightPage,
  budget: FetchBudget,
): Promise<void> {
  if (!p.url().startsWith(PIXIV_BASE_URL)) {
    await budget.run(
      (timeout) =>
        p.goto(PIXIV_BASE_URL, { waitUntil: 'domcontentloaded', timeout }),
      REQUEST_TIMEOUT_MS,
    );
  }
  await waitForChallengeClear(p, budget);
  await waitForPixivSession(budget);
  await waitForReadyPage(p, budget);
}

async function pageFetch(
  p: PlaywrightPage,
  url: string,
  budget: FetchBudget,
): Promise<{ status: number; text: string; contentType: string }> {
  return budget.run(
    (timeoutMs) =>
      p.evaluate(
        async ({ target, timeoutMs }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(target, {
              credentials: 'include',
              signal: controller.signal,
            });
            return {
              status: res.status,
              text: await res.text(),
              contentType: res.headers.get('content-type') || '',
            };
          } finally {
            clearTimeout(timer);
          }
        },
        { target: url, timeoutMs },
      ),
    REQUEST_TIMEOUT_MS,
    () => {
      // The in-page controller cancels normal fetch/body stalls. If the renderer
      // itself is wedged, close this page so it cannot leak into a later attempt.
      if (page === p) page = null;
      void p.close().catch(() => undefined);
    },
  );
}

export async function solveCloudflare(
  budget = new FetchBudget(),
): Promise<boolean> {
  const p = await getPage(budget);
  return retryAfterNavigation(p, budget, async () => {
    await ensureClearedPage(p, budget);
    const title = await budget.run(() => p.title());
    const url = p.url();
    const ready =
      url.startsWith(PIXIV_BASE_URL) &&
      !isChallengeTitle(title) &&
      !/^\s*Loading(?:\s|$)/i.test(title) &&
      (title.trim() !== '' || new URL(url).pathname !== '/') &&
      (await hasPixivSession(budget));
    console.log(`Cloudflare browser solve ${ready ? 'ok' : 'not ready'}`);
    return ready;
  });
}

export async function fetchWithBrowser(
  url: string,
  budget = new FetchBudget(),
): Promise<{ status: number; text: string; contentType: string }> {
  const p = await getPage(budget);
  return retryAfterNavigation(p, budget, async () => {
    await ensureClearedPage(p, budget);
    let result = await pageFetch(p, url, budget);
    if (isChallengeBody(result.text)) {
      await budget.run(
        (timeout) => p.goto(url, { waitUntil: 'domcontentloaded', timeout }),
        REQUEST_TIMEOUT_MS,
      );
      await waitForChallengeClear(p, budget);
      await waitForReadyPage(p, budget);
      result = await pageFetch(p, url, budget);
    }
    throwIfChallengeBody(url, result.text);
    return result;
  });
}

export async function closeBrowser(
  cleanup = new FetchBudget(5000),
): Promise<void> {
  lastChallengeWaitMs = null;
  launchPromise = null;
  browserGeneration++;
  const currentPage = page;
  const currentContext = context;
  const currentBrowser = browser;
  page = null;
  context = null;
  browser = null;
  const operations = [
    () =>
      currentPage && !currentPage.isClosed()
        ? currentPage.close()
        : Promise.resolve(),
    () => currentContext?.close() ?? Promise.resolve(),
    () => currentBrowser?.close() ?? Promise.resolve(),
  ];
  const failures: unknown[] = [];
  for (const [index, operation] of operations.entries()) {
    // Close children before parents to avoid TargetClosed races. Reserve part
    // of the shared grace period for each remaining resource, even if one hangs.
    const pending = Promise.resolve().then(operation);
    void pending.catch(() => undefined);
    try {
      await cleanup.run(
        () => pending,
        Math.max(
          1,
          Math.floor(cleanup.remainingMs() / (operations.length - index)),
        ),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new FetchCleanupError(
      new AggregateError(failures, 'Browser cleanup failures'),
    );
}
