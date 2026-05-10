/**
 * Concurrency semaphore — allows up to `maxConcurrent` ESI requests to be
 * in-flight at the same time while queuing the rest. This is much faster than
 * a serial queue with a fixed delay because ESI's real constraint is concurrent
 * connections, not requests-per-second.
 */
class RateLimiterService {
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  public async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeCount--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export const rateLimiterService = new RateLimiterService(5);
