import { createSession, type Session } from 'wreq-js';
import { FETCH_DELAY_MS } from '../constants';
import {
  closeBrowser,
  fetchWithBrowser,
  solveCloudflare,
} from './solveCloudflare';
import {
  CloudflareError,
  HttpError,
  FetchSetupError,
  FetchCleanupError,
  FetchTimeoutError,
  fetchErrorCategory,
  isTransientFetchError,
} from './errors';
import { FetchBudget, REQUEST_TIMEOUT_MS } from './budget';

export { CloudflareError, HttpError } from './errors';

const MAX_ATTEMPTS = 3;

export type FetchResponse = {
  data: unknown;
  status: number;
};

let session: Session | null = null;
let sessionPromise: Promise<Session> | null = null;
let fetchQueue: Promise<unknown> = Promise.resolve();
let useBrowserFetch = false;

function sessionOptions() {
  return {
    browser: 'chrome' as const,
    os: 'windows' as const,
    timeout: REQUEST_TIMEOUT_MS,
    defaultHeaders: {
      Referer: 'https://dic.pixiv.net/',
    },
  };
}

async function getSession(budget: FetchBudget): Promise<Session> {
  if (session && !session.closed) {
    return session;
  }
  if (!sessionPromise) {
    const pending = createSession(sessionOptions()).then(async (created) => {
      // A timed-out setup must not repopulate a closed/replaced session.
      if (sessionPromise !== pending || budget.remainingMs() === 0) {
        void created.close().catch(() => undefined);
        throw new FetchTimeoutError(true);
      }
      session = created;
      return created;
    });
    sessionPromise = pending;
  }
  try {
    return await budget.run(() => sessionPromise!, REQUEST_TIMEOUT_MS);
  } catch (error) {
    sessionPromise = null;
    if (error instanceof FetchTimeoutError && error.budgetExhausted)
      throw error;
    throw new FetchSetupError(error);
  }
}

async function closeHttpSession(): Promise<void> {
  sessionPromise = null;
  const current = session;
  session = null;
  if (current && !current.closed) await current.close();
}

export async function closeSession(
  cleanup = new FetchBudget(5000),
): Promise<void> {
  useBrowserFetch = false;
  // Attempt every cleanup even if another fails, but never hang the CLI.
  try {
    const results = await cleanup.run(() =>
      Promise.allSettled([
        Promise.resolve().then(closeHttpSession),
        Promise.resolve().then(() => closeBrowser(cleanup)),
      ]),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, 'Fetch cleanup failures');
  } catch (error) {
    throw new FetchCleanupError(error);
  }
}

function isCloudflareChallenge(status: number, body: string): boolean {
  if (
    /<title>\s*Just a moment\.+\s*<\/title>/i.test(body) ||
    /<title>\s*しばらくお待ちください/.test(body)
  ) {
    return true;
  }
  return status === 403 && /challenge-platform/i.test(body);
}

function parseData(text: string, contentType: string): unknown {
  if (
    contentType.includes('application/json') ||
    contentType.includes('+json')
  ) {
    return JSON.parse(text);
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = fetchQueue.then(fn, fn);
  fetchQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function toFetchResponse(
  status: number,
  text: string,
  contentType: string,
): FetchResponse {
  if (isCloudflareChallenge(status, text)) {
    throw new CloudflareError();
  }
  if (status === 404) {
    throw new HttpError(404, 'Not found');
  }
  if (status >= 400) {
    throw new HttpError(status, `HTTP ${status}`);
  }
  return {
    data: parseData(text, contentType),
    status,
  };
}

async function fetchBrowserResponse(
  url: string,
  budget: FetchBudget,
): Promise<FetchResponse> {
  const response = await fetchWithBrowser(url, budget);
  return toFetchResponse(response.status, response.text, response.contentType);
}

async function fetchURLInner(
  url: string,
  budget: FetchBudget,
): Promise<FetchResponse> {
  if (FETCH_DELAY_MS > 0) await budget.sleep(FETCH_DELAY_MS);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    budget.timeout();
    try {
      if (useBrowserFetch) return await fetchBrowserResponse(url, budget);
      const current = await getSession(budget);
      const controller = new AbortController();
      const { response, text } = await budget.run(
        async (timeout) => {
          const response = await current.fetch(url, {
            timeout,
            signal: controller.signal,
          });
          return { response, text: await response.text() };
        },
        REQUEST_TIMEOUT_MS,
        () => controller.abort(),
      );
      if (isCloudflareChallenge(response.status, text)) {
        console.log(
          `Cloudflare challenge (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        if (await solveCloudflare(budget)) {
          useBrowserFetch = true;
          // Complete the handoff even when this is the final attempt.
          return await fetchBrowserResponse(url, budget);
        }
        throw new CloudflareError();
      }
      return toFetchResponse(
        response.status,
        text,
        response.headers.get('content-type') || '',
      );
    } catch (error) {
      if (!isTransientFetchError(error) || attempt + 1 >= MAX_ATTEMPTS)
        throw error;
      const baseMs =
        error instanceof HttpError && error.status === 429
          ? 20_000
          : 5000 * 3 ** attempt;
      // Positive jitter never undercuts a challenge's cooldown hint.
      const delayMs = Math.max(
        Math.round(baseMs * (1 + Math.random() * 0.2)),
        error instanceof CloudflareError ? error.retryAfterMs : 0,
      );
      console.log(
        `Fetch retry category=${fetchErrorCategory(error)} attempt=${attempt + 1}/${MAX_ATTEMPTS} delayMs=${delayMs}`,
      );
      if (
        !useBrowserFetch &&
        !(error instanceof CloudflareError) &&
        !(error instanceof HttpError)
      ) {
        await budget.run(() => closeHttpSession(), 5000);
      }
      await budget.sleep(delayMs);
    }
  }
  throw new Error('Fetch attempts exhausted');
}

export async function fetchURL(
  url: string,
  budget?: FetchBudget,
): Promise<FetchResponse> {
  return serialized(() => fetchURLInner(url, budget ?? new FetchBudget()));
}
