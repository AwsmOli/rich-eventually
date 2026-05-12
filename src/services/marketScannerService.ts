import { ref } from "vue";

import { MAJOR_REGIONS } from "./arbitrageService";
import { esiApiService } from "./esiApiService";
import { kvGet, kvSet } from "./idbService";
import { marketDataService } from "./marketDataService";

// Spread region refreshes evenly across a 5-min window on startup so we don't
// burst all regions at once. After the first fetch the schedule is driven by
// each region's own ESI Expires header.
const INITIAL_STAGGER_MS = Math.floor((5 * 60 * 1000) / MAJOR_REGIONS.length); // ~16.7 s

export const REGION_NAMES: Record<number, string> = {
  10000002: "The Forge",
  10000033: "The Citadel",
  10000016: "Lonetrek",
  10000043: "Domain",
  10000052: "Kador",
  10000049: "Khanid",
  10000065: "Kor-Azor",
  10000020: "Tash-Murkon",
  10000067: "Genesis",
  10000030: "Heimatar",
  10000042: "Metropolis",
  10000028: "Molden Heath",
  10000064: "Essence",
  10000032: "Sinq Laison",
  10000037: "Everyshore",
  10000048: "Placid",
  10000068: "Verge Vendor",
  10000036: "Devoid",
};

class MarketScannerService {
  /** True while any region is actively being fetched. */
  public readonly isFetchingOrders = ref(false);
  /** Page progress for the region currently being fetched. */
  public readonly fetchProgress = ref({ current: 0, total: 0 });
  /** Timestamp of the most recently completed region fetch. */
  public readonly lastOrdersFetchedAt = ref<number | undefined>(undefined);
  /** Seconds until the next scheduled region refresh. */
  public readonly nextRefreshIn = ref<number | undefined>(undefined);
  /** Per-region last-fetched timestamps (ms). */
  public readonly regionFetchedAt = ref<Map<number, number>>(new Map());
  /** The region currently being fetched, if any. */
  public readonly fetchingRegionId = ref<number | undefined>(undefined);
  /** Page count from the most recent completed fetch per region. */
  public readonly regionPageCount = ref<Map<number, number>>(new Map());
  /** Regions that have been paused by the user. */
  public readonly pausedRegions = ref<Set<number>>(new Set());
  /** Whether the background auto-refresh is enabled. */
  public readonly autoUpdate = ref(true);

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
      if (
        !this.activeRegions.has(regionId) &&
        !this.pausedRegions.value.has(regionId)
      ) {
        this.scheduleRegion(regionId, delay, /* manual */ true);
        delay += INITIAL_STAGGER_MS;
      }
    }
  }

  /**
   * Toggle pause for a region. Pausing cancels its scheduled fetch, clears
   * all cached order data for that region, and prevents future scheduling.
   * Unpausing re-schedules an immediate fetch.
   */
  public toggleRegionPause(regionId: number): void {
    const paused = new Set(this.pausedRegions.value);
    if (paused.has(regionId)) {
      paused.delete(regionId);
      this.pausedRegions.value = paused;
      void kvSet("market-paused-regions", [...paused]);
      if (this.autoUpdate.value) this.scheduleRegion(regionId, 0);
    } else {
      paused.add(regionId);
      this.pausedRegions.value = paused;
      void kvSet("market-paused-regions", [...paused]);
      // Cancel any pending fetch for this region.
      const existing = this.scheduled.get(regionId);
      if (existing !== undefined) {
        clearTimeout(existing.id);
        this.scheduled.delete(regionId);
      }
      // Wipe cached data.
      marketDataService.clearRegion(regionId);
      const nextTs = new Map(this.regionFetchedAt.value);
      nextTs.delete(regionId);
      this.regionFetchedAt.value = nextTs;
      const nextPg = new Map(this.regionPageCount.value);
      nextPg.delete(regionId);
      this.regionPageCount.value = nextPg;
    }
  }

  private async init(): Promise<void> {
    // Restore persisted settings before scheduling.
    const [savedPaused, savedAutoUpdate] = await Promise.all([
      kvGet<number[]>("market-paused-regions"),
      kvGet<boolean>("market-auto-update"),
    ]);
    if (savedPaused) this.pausedRegions.value = new Set(savedPaused);
    if (savedAutoUpdate !== undefined && savedAutoUpdate !== null) {
      this.autoUpdate.value = savedAutoUpdate;
    }

    if (!this.autoUpdate.value) {
      this.startCountdown();
      return;
    }

    // Schedule all regions immediately (staggered so we don't burst ESI).
    MAJOR_REGIONS.forEach((regionId, index) => {
      if (!this.pausedRegions.value.has(regionId)) {
        this.scheduleRegion(regionId, index * INITIAL_STAGGER_MS);
      }
    });

    this.startCountdown();
  }

  /** Toggle background auto-refresh on/off. Persists the setting. */
  public toggleAutoUpdate(): void {
    this.autoUpdate.value = !this.autoUpdate.value;
    void kvSet("market-auto-update", this.autoUpdate.value);
    if (this.autoUpdate.value) {
      this.forceRefresh();
    } else {
      for (const { id } of this.scheduled.values()) clearTimeout(id);
      this.scheduled.clear();
      this.nextRefreshIn.value = undefined;
    }
  }

  private scheduleRegion(
    regionId: number,
    delayMs: number,
    manual = false,
  ): void {
    const existing = this.scheduled.get(regionId);
    if (existing !== undefined) clearTimeout(existing.id);

    const at = Date.now() + delayMs;
    const id = setTimeout(() => {
      this.scheduled.delete(regionId);
      void this.refreshRegion(regionId, manual);
    }, delayMs);

    this.scheduled.set(regionId, { id, at });
  }

  private async refreshRegion(regionId: number, manual = false): Promise<void> {
    // Enqueue behind any currently running fetch — only one region at a time.
    // Capture the current generation so we can skip if it changes before we run.
    const gen = this.generation;
    this.fetchQueue = this.fetchQueue.then(() =>
      this.doRefreshRegion(regionId, gen, manual),
    );
    await this.fetchQueue;
  }

  private async doRefreshRegion(
    regionId: number,
    gen: number,
    manual = false,
  ): Promise<void> {
    // Skip work that was queued before the last wake/forceRefresh cycle.
    if (gen !== this.generation) return;

    // Wait out any active rate-limit pause before starting.
    await esiApiService.waitIfPaused();

    // Skip if auto-update is off (unless this is a manual refresh) or region is paused.
    if (
      (!manual && !this.autoUpdate.value) ||
      this.pausedRegions.value.has(regionId)
    )
      return;

    this.activeRegions.add(regionId);
    this.isFetchingOrders.value = true;
    this.fetchProgress.value = { current: 0, total: 0 };
    this.fetchingRegionId.value = regionId;
    this.nextRefreshIn.value = undefined;

    let expiresAt: number | undefined;
    let lastTotal = 0;
    try {
      expiresAt = await marketDataService.fetchAndIndexRegion(
        regionId,
        (done, total) => {
          this.fetchProgress.value = { current: done, total };
          lastTotal = total;
        },
      );
      this.lastOrdersFetchedAt.value = Date.now();
      // Update per-region maps (replace to trigger reactivity).
      const nextTs = new Map(this.regionFetchedAt.value);
      nextTs.set(regionId, Date.now());
      this.regionFetchedAt.value = nextTs;
      if (lastTotal > 0) {
        const nextPg = new Map(this.regionPageCount.value);
        nextPg.set(regionId, lastTotal);
        this.regionPageCount.value = nextPg;
      }
    } catch {
      // One region failing should not abort the rest.
    }

    this.activeRegions.delete(regionId);
    if (this.activeRegions.size === 0) {
      this.isFetchingOrders.value = false;
      this.fetchingRegionId.value = undefined;
    }

    // Schedule next refresh from ESI's Expires header.
    // Enforce a minimum of 4 minutes: large regions take many pages to fetch,
    // so by the time doFetchAndIndex returns the first-page Expires may already
    // be almost past, which would cause a tight re-fetch loop.
    // Fall back to 5 minutes if the header was absent.
    const delay = expiresAt
      ? Math.max(4 * 60_000, expiresAt - Date.now() + 2_000)
      : 5 * 60_000;
    if (this.autoUpdate.value) this.scheduleRegion(regionId, delay);
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
