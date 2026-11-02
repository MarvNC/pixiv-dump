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
import { challengeEvidence, type ChallengeResponse } from './challenge';
import {
  fetchDiagnostic,
  recordFetchDiagnostic,
  recordPrecedingChallenge,
} from './diagnostics';

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
let lastFetchCompletedAt: number | null = null;

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
  lastFetchCompletedAt = null;
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
  cfMitigated?: string | null,
): FetchResponse {
  if (challengeEvidence({ status, text, contentType, cfMitigated })) {
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
  try {
    return toFetchResponse(
      response.status,
      response.text,
      response.contentType,
      response.cfMitigated,
    );
  } catch (error) {
    recordFetchDiagnostic(
      error,
      url,
      'browser',
      response,
      challengeEvidence(response) ?? undefined,
    );
    throw error;
  }
}

async function fetchURLInner(
  url: string,
  budget: FetchBudget,
): Promise<FetchResponse> {
  if (lastFetchCompletedAt !== null) {
    const delay = Math.max(
      0,
      FETCH_DELAY_MS - (Date.now() - lastFetchCompletedAt),
    );
    if (delay > 0) await budget.sleep(delay);
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    budget.timeout();
    let httpResponse: ChallengeResponse | undefined;
    let transport: 'http' | 'browser' = useBrowserFetch ? 'browser' : 'http';
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
      httpResponse = {
        status: response.status,
        text,
        contentType: response.headers.get('content-type') || '',
        cfMitigated: response.headers.get('cf-mitigated') || '',
      };
      if (challengeEvidence(httpResponse)) {
        console.log(
          `Cloudflare challenge (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        transport = 'browser';
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
        httpResponse.contentType,
        httpResponse.cfMitigated,
      );
    } catch (error) {
      if (transport === 'browser' && httpResponse) {
        const preceding = challengeEvidence(httpResponse);
        if (preceding)
          recordPrecedingChallenge(error, url, httpResponse, preceding);
      }
      recordFetchDiagnostic(
        error,
        url,
        transport,
        transport === 'browser' ? undefined : httpResponse,
        transport === 'http' && httpResponse
          ? challengeEvidence(httpResponse) ?? undefined
          : undefined,
      );
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
        `Fetch retry category=${fetchErrorCategory(error)} attempt=${attempt + 1}/${MAX_ATTEMPTS} delayMs=${delayMs} diagnostic=${JSON.stringify(fetchDiagnostic(error))}`,
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
  return serialized(async () => {
    try {
      return await fetchURLInner(url, budget ?? new FetchBudget());
    } catch (error) {
      recordFetchDiagnostic(error, url, useBrowserFetch ? 'browser' : 'http');
      console.error(
        `Fetch failed category=${fetchErrorCategory(error)} diagnostic=${JSON.stringify(fetchDiagnostic(error))}`,
      );
      throw error;
    } finally {
      lastFetchCompletedAt = Date.now();
    }
  });
}
