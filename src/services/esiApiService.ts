import {
  Configuration,
  MarketApi,
  ResponseError,
  RoutesApi,
  UniverseApi,
} from "@evespace/esi-client";

import { rateLimiterService } from "./rateLimiterService";
import { toastService } from "./toastService";

interface RetryableError {
  status?: number;
  retryAfterMs?: number;
  message: string;
}

class EsiApiService {
  public readonly marketApi: MarketApi;
  public readonly routesApi: RoutesApi;
  public readonly universeApi: UniverseApi;

  // Global pause gate — all requests wait on this promise when ESI signals 429.
  private pausedUntil = 0;
  private pausePromise: Promise<void> | undefined;
  private pauseResolve: (() => void) | undefined;
  // Tracks consecutive 429/420 responses to apply exponential backoff.
  private consecutiveRateLimits = 0;

  public constructor() {
    const configuration = new Configuration({
      basePath: "https://esi.evetech.net",
    });

    this.marketApi = new MarketApi(configuration);
    this.routesApi = new RoutesApi(configuration);
    this.universeApi = new UniverseApi(configuration);
  }

  /**
   * Enqueues an ESI operation with automatic retry on transient errors.
   * On 429, triggers a global pause so all concurrent requests back off together
   * before retrying. The semaphore slot is always released before any sleep.
   */
  public async execute<T>(
    label: string,
    operation: () => Promise<T>,
    options?: { silent404?: boolean },
  ): Promise<T> {
    const maxAttempts = 3;
    let attempt = 0;

    while (true) {
      // Avoid entering the queue while a global pause is active.
      await this.waitIfPaused();

      type SlotResult<V> =
        | { ok: true; value: V }
        | {
            ok: false;
            status: number | undefined;
            retryAfterMs: number | undefined;
            message: string;
          };

      const result = await rateLimiterService.enqueue<SlotResult<T>>(
        async () => {
          // Re-check after acquiring the slot — a 429 may have fired while we
          // were waiting in the queue. This is the key check: the slot is held
          // here, so any request that was already queued will wait here instead
          // of firing immediately when a slot opens during a pause.
          await this.waitIfPaused();
          try {
            return { ok: true, value: await operation() };
          } catch (error: unknown) {
            const retryable = this.toRetryableError(error);
            // Trigger the global pause INSIDE the semaphore slot, before it's
            // released — so the next waiter in the queue sees the pause before
            // it starts, closing the race window.
            if (retryable.status === 420 || retryable.status === 429) {
              this.consecutiveRateLimits++;
              // ESI often sends Retry-After: 1 which is too short; enforce a
              // 15s floor and double for each consecutive 429 (max 4×).
              const base = Math.max(15_000, retryable.retryAfterMs ?? 30_000);
              const pauseMs = base * Math.min(this.consecutiveRateLimits, 4);
              toastService.push(
                `ESI rate limit hit — pausing ${Math.round(pauseMs / 1000)}s`,
                "warning",
                pauseMs + 1000,
              );
              this.triggerPause(pauseMs);
            }
            return {
              ok: false,
              status: retryable.status,
              retryAfterMs: retryable.retryAfterMs,
              message: retryable.message,
            };
          }
        },
      );

      if (result.ok) {
        this.consecutiveRateLimits = 0;
        return result.value;
      }

      attempt += 1;
      const shouldRetry = this.isRetryableStatus(result.status);
      if (!shouldRetry || attempt >= maxAttempts) {
        const msg = `ESI error — ${label}: ${result.message}`;
        const silent = options?.silent404 === true && result.status === 404;
        if (!silent) {
          toastService.push(msg, result.status === 404 ? "warning" : "error");
        }
        throw new Error(msg);
      }

      if (result.status !== 420 && result.status !== 429) {
        // Non-rate-limit transient error: simple per-request exponential backoff.
        await this.sleep(300 * Math.pow(2, attempt));
      }
      // For 429, the pause was triggered inside enqueue above.
      // The next iteration will await waitIfPaused() before re-entering the queue.
    }
  }

  /** Returns a promise that resolves once the global pause (if any) has lifted. Public so callers can wait before starting new work. */
  public waitIfPaused(): Promise<void> {
    return this.pausePromise ?? Promise.resolve();
  }

  /**
   * Sets or extends the global pause window.
   * Multiple concurrent 429 callers converge on a single shared promise;
   * each may call triggerPause, but only the longest timeout resolves it.
   */
  private triggerPause(ms: number): void {
    const newResumeAt = Date.now() + ms;
    if (newResumeAt <= this.pausedUntil) return; // already paused at least this long

    this.pausedUntil = newResumeAt;

    // Create the shared gate promise on the first 429 in a burst.
    if (this.pausePromise === undefined) {
      this.pausePromise = new Promise<void>((resolve) => {
        this.pauseResolve = resolve;
      });
    }

    // Schedule resolution. Earlier timeouts from previous triggerPause calls will
    // fire but do nothing because Date.now() < this.pausedUntil at that point.
    setTimeout(() => {
      if (Date.now() >= this.pausedUntil) {
        this.pausePromise = undefined;
        const resolve = this.pauseResolve;
        this.pauseResolve = undefined;
        resolve?.();
      }
    }, ms);
  }

  private toRetryableError(error: unknown): RetryableError {
    if (error instanceof ResponseError) {
      const retryAfterHeader = error.response.headers.get("retry-after");
      const retryAfterMs =
        retryAfterHeader !== null ? Number(retryAfterHeader) * 1000 : undefined;
      return {
        status: error.response.status,
        retryAfterMs,
        message: `HTTP ${error.response.status}`,
      };
    }

    if (error instanceof Error) {
      return { message: error.message };
    }

    return { message: "Unknown ESI error" };
  }

  private isRetryableStatus(status: number | undefined): boolean {
    if (status === undefined) return true;
    return status === 420 || status === 429 || status >= 500;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const esiApiService = new EsiApiService();
