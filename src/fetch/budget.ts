import { FetchTimeoutError } from './errors';

export const FETCH_BUDGET_MS = 300_000;
export const REQUEST_TIMEOUT_MS = 60_000;

// A queued request gets one budget when it starts, not a fresh timeout per retry.
export class FetchBudget {
  private readonly deadline: number;

  constructor(timeoutMs = FETCH_BUDGET_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('Fetch budget must be a positive finite duration');
    }
    this.deadline = Date.now() + timeoutMs;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  timeout(maxMs = FETCH_BUDGET_MS): number {
    const remaining = this.remainingMs();
    if (remaining <= 0) throw new FetchTimeoutError(true);
    return Math.max(1, Math.min(maxMs, remaining));
  }

  async run<T>(
    operation: (timeoutMs: number) => Promise<T>,
    maxMs = FETCH_BUDGET_MS,
    onTimeout?: () => void,
  ): Promise<T> {
    const timeoutMs = this.timeout(maxMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation(timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Reject first so cancellation cannot replace the timeout reason.
            reject(new FetchTimeoutError(this.remainingMs() <= 0));
            onTimeout?.();
          }, timeoutMs);
        }),
      ]);
      this.timeout();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async sleep(ms: number): Promise<void> {
    // Never shorten a challenge cooldown and then spend an attempt too early.
    if (ms >= this.timeout()) throw new FetchTimeoutError(true);
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.timeout();
  }
}
