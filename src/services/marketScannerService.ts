import { ref } from "vue";

import { MAJOR_REGIONS } from "./arbitrageService";
import { esiApiService } from "./esiApiService";
import { marketDataService } from "./marketDataService";

// Spread region refreshes evenly across a 5-min window on startup so we don't
// burst all regions at once. After the first fetch the schedule is driven by
// each region's own ESI Expires header.
const INITIAL_STAGGER_MS = Math.floor((5 * 60 * 1000) / MAJOR_REGIONS.length); // ~16.7 s

class MarketScannerService {
  /** True while any region is actively being fetched. */
  public readonly isFetchingOrders = ref(false);
  /** Page progress for the region currently being fetched. */
  public readonly fetchProgress = ref({ current: 0, total: 0 });
  /** Timestamp of the most recently completed region fetch. */
  public readonly lastOrdersFetchedAt = ref<number | undefined>(undefined);
  /** Seconds until the next scheduled region refresh. */
  public readonly nextRefreshIn = ref<number | undefined>(undefined);

  private readonly activeRegions = new Set<number>();
  private readonly scheduled = new Map<
    number,
    { id: ReturnType<typeof setTimeout>; at: number }
  >();
  private countdownId: ReturnType<typeof setInterval> | undefined;
  // Single-slot queue: only one region fetch runs at a time.
  // New regions wait for the current one to finish before starting.
  private fetchQueue: Promise<void> = Promise.resolve();
  // Incremented on wake so queued-but-stale work from before sleep is skipped.
  private generation = 0;

  constructor() {
    void this.init();

    // When the tab becomes visible again (e.g. wake from sleep), all setTimeout
    // timers that expired during sleep fire simultaneously — potentially queuing
    // all regions at once. Bump the generation to skip that stale queued work,
    // then re-stagger fresh from now.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.generation++;
        this.forceRefresh();
      }
    });
  }

  public stop(): void {
    for (const { id } of this.scheduled.values()) clearTimeout(id);
    this.scheduled.clear();
    if (this.countdownId !== undefined) {
      clearInterval(this.countdownId);
      this.countdownId = undefined;
    }
    this.nextRefreshIn.value = undefined;
  }

  /** Cancel all pending refreshes and re-stagger them starting now. */
  public forceRefresh(): void {
    for (const { id } of this.scheduled.values()) clearTimeout(id);
    this.scheduled.clear();
    let delay = 0;
    for (const regionId of MAJOR_REGIONS) {
      if (!this.activeRegions.has(regionId)) {
        this.scheduleRegion(regionId, delay);
        delay += INITIAL_STAGGER_MS;
      }
    }
  }

  private async init(): Promise<void> {
    // Schedule all regions immediately (staggered so we don't burst ESI).
    MAJOR_REGIONS.forEach((regionId, index) => {
      this.scheduleRegion(regionId, index * INITIAL_STAGGER_MS);
    });

    this.startCountdown();
  }

  private scheduleRegion(regionId: number, delayMs: number): void {
    const existing = this.scheduled.get(regionId);
    if (existing !== undefined) clearTimeout(existing.id);

    const at = Date.now() + delayMs;
    const id = setTimeout(() => {
      this.scheduled.delete(regionId);
      void this.refreshRegion(regionId);
    }, delayMs);

    this.scheduled.set(regionId, { id, at });
  }

  private async refreshRegion(regionId: number): Promise<void> {
    // Enqueue behind any currently running fetch — only one region at a time.
    // Capture the current generation so we can skip if it changes before we run.
    const gen = this.generation;
    this.fetchQueue = this.fetchQueue.then(() =>
      this.doRefreshRegion(regionId, gen),
    );
    await this.fetchQueue;
  }

  private async doRefreshRegion(regionId: number, gen: number): Promise<void> {
    // Skip work that was queued before the last wake/forceRefresh cycle.
    if (gen !== this.generation) return;

    // Wait out any active rate-limit pause before starting.
    await esiApiService.waitIfPaused();

    this.activeRegions.add(regionId);
    this.isFetchingOrders.value = true;
    this.fetchProgress.value = { current: 0, total: 0 };
    this.nextRefreshIn.value = undefined;

    let expiresAt: number | undefined;
    try {
      expiresAt = await marketDataService.fetchAndIndexRegion(regionId, (done, total) => {
        this.fetchProgress.value = { current: done, total };
      });
      this.lastOrdersFetchedAt.value = Date.now();
    } catch {
      // One region failing should not abort the rest.
    }

    this.activeRegions.delete(regionId);
    if (this.activeRegions.size === 0) {
      this.isFetchingOrders.value = false;
    }

    // Schedule next refresh from ESI's Expires header; fall back to 30 s if absent.
    const delay = expiresAt
      ? Math.max(5_000, expiresAt - Date.now() + 2_000)
      : 30_000;
    this.scheduleRegion(regionId, delay);
  }

  private startCountdown(): void {
    if (this.countdownId !== undefined) return;
    this.countdownId = setInterval(() => {
      if (this.activeRegions.size > 0 || this.scheduled.size === 0) return;
      let minAt = Infinity;
      for (const { at } of this.scheduled.values()) {
        if (at < minAt) minAt = at;
      }
      this.nextRefreshIn.value =
        minAt === Infinity
          ? undefined
          : Math.max(0, Math.ceil((minAt - Date.now()) / 1000));
    }, 1000);
  }
}

export const marketScannerService = new MarketScannerService();
