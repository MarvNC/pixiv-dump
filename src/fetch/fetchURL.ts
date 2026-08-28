import { createSession, type Session } from 'wreq-js';
import { FETCH_DELAY_MS } from '../constants';
import {
  closeBrowser,
  fetchWithBrowser,
  solveCloudflare,
} from './solveCloudflare';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class CloudflareError extends Error {
  constructor(message = 'Blocked by Cloudflare challenge') {
    super(message);
    this.name = 'CloudflareError';
  }
}

export type FetchResponse = {
  data: unknown;
  status: number;
};

let session: Session | null = null;
let sessionPromise: Promise<Session> | null = null;
let fetchQueue: Promise<unknown> = Promise.resolve();
let useBrowserFetch = false;

function sessionOptions() {
  const proxy =
    process.env.PIXIV_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY;
  return {
    browser: 'chrome' as const,
    os: 'windows' as const,
    timeout: REQUEST_TIMEOUT_MS,
    defaultHeaders: {
      Referer: 'https://dic.pixiv.net/',
    },
    ...(proxy ? { proxy } : {}),
  };
}

async function getSession(): Promise<Session> {
  if (session && !session.closed) {
    return session;
  }
  if (!sessionPromise) {
    sessionPromise = createSession(sessionOptions())
      .then((created) => {
        session = created;
        return created;
      })
      .catch((error) => {
        sessionPromise = null;
        throw error;
      });
  }
  return sessionPromise;
}

export async function closeSession(): Promise<void> {
  useBrowserFetch = false;
  sessionPromise = null;
  const current = session;
  session = null;
  if (current && !current.closed) {
    await current.close();
  }
  await closeBrowser();
}

function isCloudflareChallenge(status: number, body: string): boolean {
  if (
    /<title>\s*Just a moment\.\.\s*<\/title>/i.test(body) ||
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchURLInner(url: string): Promise<FetchResponse> {
  if (FETCH_DELAY_MS > 0) {
    await sleep(FETCH_DELAY_MS);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (useBrowserFetch) {
        const browserResponse = await fetchWithBrowser(url);
        return toFetchResponse(
          browserResponse.status,
          browserResponse.text,
          browserResponse.contentType,
        );
      }
      const current = await getSession();
      const response = await current.fetch(url);
      const text = await response.text();
      if (isCloudflareChallenge(response.status, text)) {
        lastError = new CloudflareError();
        console.log(
          `Cloudflare challenge on ${url} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        const solved = await solveCloudflare();
        if (solved) {
          useBrowserFetch = true;
          continue;
        }
        await sleep(5000 * 3 ** attempt);
        continue;
      }
      return toFetchResponse(
        response.status,
        text,
        response.headers.get('content-type') || '',
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) {
        lastError = error;
        console.log(`HTTP 429 for ${url}, waiting 20000ms`);
        await sleep(20_000);
        continue;
      }
      if (error instanceof HttpError) {
        throw error;
      }
      lastError = error;
      if (useBrowserFetch) {
        console.log(`Browser fetch failed for ${url}: ${error}`);
        continue;
      }
      await closeSession();
      await sleep(5000 * 3 ** attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${url}`);
}

export async function fetchURL(url: string): Promise<FetchResponse> {
  return serialized(() => fetchURLInner(url));
}
