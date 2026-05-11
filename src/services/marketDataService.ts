import type {
  GetMarketsRegionIdHistory200Ok,
  GetMarketsRegionIdOrders200Ok,
} from "@evespace/esi-client";

import { ref } from "vue";

import type { TypeDetails } from "../types/domain";
import {
  getMockLocationNames,
  getMockOrders,
  isMockModeEnabled,
  MOCK_TYPE_DETAILS,
} from "../utils/mockData";
import { esiApiService } from "./esiApiService";
import { eveAuthService } from "./eveAuthService";
import {
  historySummaryGet,
  historySummaryPut,
  marketOrdersGet,
  typeCacheClear,
  typeCacheGetAll,
  typeCachePutBulk,
} from "./idbService";
import { systemsService } from "./systemsService";

interface CachedEntry<T> {
  value: T;
  expiresAt: number;
}

// Compact storage format for a single order — field names omitted to save space.
// Layout: [typeId, price, isBuyOrder(0|1), systemId, volumeRemain, minVolume, locationId]
type CompactOrder = [number, number, 0 | 1, number, number, number, number];

interface SystemDetails {
  systemId: number;
  name: string;
  securityStatus: number;
  x: number;
  z: number;
}

class MarketDataService {
  /** Per-region flat order arrays, populated by fetchAndIndexRegion. */
  private readonly regionOrderCache = new Map<
    number,
    GetMarketsRegionIdOrders200Ok[]
  >();
  /** In-flight fetch promises, keyed by regionId — prevents duplicate concurrent fetches. */
  private readonly regionFetchPromises = new Map<
    number,
    Promise<number | undefined>
  >();
  /** Cheapest sell price per type per system, built after each full region fetch. */
  private readonly cheapestSellBySystemType = new Map<
    number,
    Map<number, number>
  >();
  /** Which system IDs were indexed from each region — used to clean up on clearRegion. */
  private readonly systemsInRegion = new Map<number, Set<number>>();
  private readonly historyCache = new Map<
    string,
    CachedEntry<GetMarketsRegionIdHistory200Ok[]>
  >();
  private readonly sellPriceCache = new Map<
    string,
    CachedEntry<number | undefined>
  >();
  private readonly nameCache = new Map<number, string>();
  private readonly typeCache = new Map<number, TypeDetails>();
  private readonly systemCache = new Map<number, SystemDetails>();
  /** locationId → regionId, resolved via ESI station/structure endpoints. */
  private readonly locationRegionCache = new Map<number, number>();
  /** systemId → regionId, derived via constellation lookup. */
  private readonly systemRegionCache = new Map<number, number>();
  /** In-memory summary cache — avoids re-parsing localStorage on repeated calls. */
  private readonly summaryCacheMemory = new Map<
    string,
    { avgOrderCount: number; avgPrice: number | undefined }
  >();
  private readonly TYPE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  /** Always resolves immediately — retained for API compatibility with marketScannerService. */
  public readonly ready: Promise<void> = Promise.resolve();
  /** Increments each time any region's orders are fully loaded — use in computed() to react to market updates. */
  public readonly marketTick = ref(0);

  constructor() {
    void this.loadTypeCacheFromStorage();
  }

  /** Clears all cached market data (all regions). */
  public clearMarketCache(): void {
    this.regionOrderCache.clear();
    this.cheapestSellBySystemType.clear();
    this.systemsInRegion.clear();
    this.regionFetchPromises.clear();
  }

  /** Clears the in-memory type cache so all types are re-fetched from ESI on next getTypeDetails call. */
  public clearTypeCache(): void {
    this.typeCache.clear();
    void typeCacheClear(); // also wipe IDB so stale records don't reload on next page visit
  }

  /** Clears cached data for a single region so it will be re-fetched. */
  public clearRegion(regionId: number): void {
    // Remove per-system sell index entries that came from this region.
    const systemIds = this.systemsInRegion.get(regionId);
    if (systemIds !== undefined) {
      for (const sid of systemIds) this.cheapestSellBySystemType.delete(sid);
      this.systemsInRegion.delete(regionId);
    }
    this.regionOrderCache.delete(regionId);
    this.regionFetchPromises.delete(regionId);
  }

  /**
   * Returns the cheapest sell price for a type at a specific system.
   * Reads from the bulk order index when available (populated by fetchAndIndexRegion),
   * then falls back to a targeted ESI call filtered to that system.
   */
  public async getCheapestSellPrice(
    systemId: number,
    regionId: number,
    typeId: number,
  ): Promise<number | undefined> {
    // Fast path: check the per-system index built by the background scanner.
    const fromIndex = this.cheapestSellBySystemType.get(systemId)?.get(typeId);
    if (fromIndex !== undefined) return fromIndex;

    // Cache key for the ESI fallback.
    const cacheKey = `sell-price:${systemId}:${typeId}`;
    const cached = this.sellPriceCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Targeted ESI call: fetch only this item's sell orders in the region,
    // then filter to the exact system so we don't pick up orders several jumps away.
    const orders = await esiApiService.execute(
      `Fetch sell orders type ${typeId} in system ${systemId}`,
      async () =>
        esiApiService.marketApi.getMarketsRegionIdOrders({
          regionId,
          typeId,
          orderType: "sell",
          datasource: "tranquility",
        }),
    );

    const systemOrders = orders.filter((o) => o.systemId === systemId);
    const cheapest =
      systemOrders.length > 0
        ? systemOrders.reduce(
            (min, o) => (o.price < min ? o.price : min),
            systemOrders[0].price,
          )
        : undefined;

    this.sellPriceCache.set(cacheKey, {
      value: cheapest,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return cheapest;
  }

  /** Returns the last `days` days of market history for a type in a region. Cached for 24 hours. */
  public async getTypeHistory(
    regionId: number,
    typeId: number,
    days = 90,
  ): Promise<GetMarketsRegionIdHistory200Ok[]> {
    const cacheKey = `history:${regionId}:${typeId}`;
    const cached = this.historyCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.value.slice(-days);
    }

    let history: GetMarketsRegionIdHistory200Ok[];
    try {
      history = await esiApiService.execute(
        `Fetch history ${typeId} in ${regionId}`,
        async () =>
          esiApiService.marketApi.getMarketsRegionIdHistory({
            regionId,
            typeId,
            datasource: "tranquility",
          }),
        { silent404: true },
      );
    } catch {
      // 404 = item has no market history in this region — treat as empty.
      return [];
    }

    this.historyCache.set(cacheKey, {
      value: history,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    return history.slice(-days);
  }

  /**
   * Returns the 90-day average order count and average price for a type in a region.
   * Persists a compact summary to localStorage (TTL 24h) to survive page reloads —
   * storing only ~80 bytes/type instead of the full ~7KB raw history.
   */
  /**
   * Synchronously returns a cached history summary if one exists in localStorage
   * or the in-memory summary cache. Returns undefined on a cache miss — no ESI call.
   */
  public getHistorySummarySync(
    regionId: number,
    typeId: number,
  ): { avgOrderCount: number; avgPrice: number | undefined } | undefined {
    // In-memory summary cache (populated by getHistorySummary calls in this session).
    const memKey = `${regionId}:${typeId}`;
    const mem = this.summaryCacheMemory.get(memKey);
    if (mem !== undefined) return mem;

    // IDB cache lookup is async — sync path only returns in-memory hits.
    // Callers that need persistence must use getHistorySummary() (async).
    return undefined;
  }

  public async getHistorySummary(
    regionId: number,
    typeId: number,
  ): Promise<{ avgOrderCount: number; avgPrice: number | undefined }> {
    // Check in-memory cache first (populated this session).
    const memKey = `${regionId}:${typeId}`;
    const mem = this.summaryCacheMemory.get(memKey);
    if (mem !== undefined) return mem;

    // Check IDB (survives page reloads).
    try {
      const record = await historySummaryGet(memKey);
      if (record !== undefined && record.expiresAt > Date.now()) {
        const result = {
          avgOrderCount: record.avgOrderCount,
          avgPrice: record.avgPrice,
        };
        this.summaryCacheMemory.set(memKey, result);
        return result;
      }
    } catch {
      /* IDB unavailable — fall through to ESI */
    }

    let avgOrderCount = 0;
    let avgPrice: number | undefined;
    try {
      const history = await this.getTypeHistory(regionId, typeId, 90);
      if (history.length > 0) {
        avgOrderCount =
          history.reduce((sum, d) => sum + d.orderCount, 0) / history.length;
        avgPrice =
          history.reduce((sum, d) => sum + d.average, 0) / history.length;
      }
    } catch {
      // 404 "Type not found" or other permanent errors — cache the empty result
      // so we don't re-request on every scan.
    }

    const result = { avgOrderCount, avgPrice };
    // Populate both caches.
    this.summaryCacheMemory.set(`${regionId}:${typeId}`, result);
    void historySummaryPut({
      key: `${regionId}:${typeId}`,
      avgOrderCount,
      avgPrice,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return result;
  }

  /**
   * Fetches ALL pages of buy and sell orders for a region with no page cap.
   * Stores results in the region order cache and builds the cheapest-sell index.
   * Deduplicates concurrent calls for the same region — callers share the same Promise.
   *
   * @param onPage  Called after each page batch with (pagesDone, pagesTotal).
   *                pagesTotal grows as x-pages headers are discovered per order type.
   * Returns the ESI `Expires` timestamp (ms) from the first page response, or undefined.
   */
  public fetchAndIndexRegion(
    regionId: number,
    onPage?: (done: number, total: number) => void,
  ): Promise<number | undefined> {
    const existing = this.regionFetchPromises.get(regionId);
    if (existing !== undefined) return existing;

    const promise = this.doFetchAndIndex(regionId, onPage).finally(() => {
      this.regionFetchPromises.delete(regionId);
    });
    this.regionFetchPromises.set(regionId, promise);
    return promise;
  }

  private async doFetchAndIndex(
    regionId: number,
    onPage?: (done: number, total: number) => void,
  ): Promise<number | undefined> {
    if (isMockModeEnabled()) {
      this.regionOrderCache.set(regionId, getMockOrders());
      return undefined;
    }

    // Mutable totals updated as x-pages headers arrive for each order type.
    let sellTotal = 1;
    let buyTotal = 1;
    let done = 0;
    const reportProgress = (): void => onPage?.(done, sellTotal + buyTotal);

    const fetchOrderType = async (
      orderType: "buy" | "sell",
    ): Promise<{
      orders: GetMarketsRegionIdOrders200Ok[];
      expiresAt: number | undefined;
    }> => {
      const firstResponse = await esiApiService.execute(
        `Fetch ${orderType} orders page 1 for region ${regionId}`,
        () =>
          esiApiService.marketApi.getMarketsRegionIdOrdersRaw({
            regionId,
            orderType,
            page: 1,
            datasource: "tranquility",
          }),
      );

      const firstOrders = await firstResponse.value();
      const xPages = Number.parseInt(
        firstResponse.raw.headers.get("x-pages") ?? "1",
        10,
      );
      const expiresHeader = firstResponse.raw.headers.get("expires");
      const expiresAt = expiresHeader
        ? new Date(expiresHeader).getTime()
        : undefined;

      if (orderType === "sell") sellTotal = xPages;
      else buyTotal = xPages;

      done++;
      reportProgress();

      const allOrders: GetMarketsRegionIdOrders200Ok[] = [...firstOrders];

      // Fetch remaining pages sequentially to avoid thundering-herd 429s.
      for (let page = 2; page <= xPages; page++) {
        const pageOrders = await esiApiService.execute(
          `Fetch ${orderType} orders page ${page} for region ${regionId}`,
          () =>
            esiApiService.marketApi.getMarketsRegionIdOrders({
              regionId,
              orderType,
              page,
              datasource: "tranquility",
            }),
        );
        for (const order of pageOrders) allOrders.push(order);
        done++;
        reportProgress();
      }

      return { orders: allOrders, expiresAt };
    };

    // Fetch sell then buy sequentially — running both in parallel doubles the
    // request rate and is the primary cause of ESI 429s.
    const { orders: sellOrders, expiresAt } = await fetchOrderType("sell");
    const { orders: buyOrders } = await fetchOrderType("buy");

    // Build cheapest sell price index BEFORE merging buy orders into the array.
    // (sellOrders array will be mutated below, so we must index it first.)
    const systemsForRegion = new Set<number>();
    for (const order of sellOrders) {
      systemsForRegion.add(order.systemId);
      let systemMap = this.cheapestSellBySystemType.get(order.systemId);
      if (systemMap === undefined) {
        systemMap = new Map();
        this.cheapestSellBySystemType.set(order.systemId, systemMap);
      }
      const current = systemMap.get(order.typeId);
      if (current === undefined || order.price < current) {
        systemMap.set(order.typeId, order.price);
      }
    }
    this.systemsInRegion.set(regionId, systemsForRegion);

    // Merge buy orders into the sell array (reuse allocation, avoid spread stack overflow).
    const allOrders: GetMarketsRegionIdOrders200Ok[] = sellOrders;
    for (const order of buyOrders) allOrders.push(order);
    this.regionOrderCache.set(regionId, allOrders);
    this.marketTick.value++;

    // Persist to localStorage so the next page load can skip this ESI burst.
    void this.saveRegionToStorage(regionId, allOrders);

    return expiresAt;
  }

  /**
   * Returns the timestamp (ms) when a region's orders were last stored, or undefined if not cached.
   * Async because it reads from IndexedDB.
   */
  public async getRegionStoredAt(
    regionId: number,
  ): Promise<number | undefined> {
    const record = await marketOrdersGet(regionId);
    return record?.storedAt;
  }

  /**
   * Restores a region's orders from localStorage into the in-memory cache and
   * rebuilds the cheapest-sell index. Returns true on success.
   */
  public async restoreRegionFromStorage(regionId: number): Promise<boolean> {
    try {
      const record = await marketOrdersGet(regionId);
      if (!record) return false;
      const compact = record.data as CompactOrder[];
      const orders: GetMarketsRegionIdOrders200Ok[] = compact.map(
        ([
          typeId,
          price,
          isBuyOrder,
          systemId,
          volumeRemain,
          minVolume,
          locationId,
        ]) =>
          ({
            typeId,
            price,
            isBuyOrder: isBuyOrder === 1,
            systemId,
            volumeRemain,
            minVolume,
            locationId,
          }) as GetMarketsRegionIdOrders200Ok,
      );
      this.regionOrderCache.set(regionId, orders);

      // Rebuild cheapest-sell index from sell orders only.
      const systemsForRegion = new Set<number>();
      for (const order of orders) {
        if (order.isBuyOrder) continue;
        systemsForRegion.add(order.systemId);
        let systemMap = this.cheapestSellBySystemType.get(order.systemId);
        if (systemMap === undefined) {
          systemMap = new Map();
          this.cheapestSellBySystemType.set(order.systemId, systemMap);
        }
        const current = systemMap.get(order.typeId);
        if (current === undefined || order.price < current) {
          systemMap.set(order.typeId, order.price);
        }
      }
      this.systemsInRegion.set(regionId, systemsForRegion);
      return true;
    } catch {
      return false;
    }
  }

  private async saveRegionToStorage(
    _regionId: number,
    _orders: GetMarketsRegionIdOrders200Ok[],
  ): Promise<void> {
    // IDB caching disabled — always fetch fresh from ESI.
  }

  /** Returns true if region orders have been loaded into the in-memory cache. */
  public isRegionLoaded(regionId: number): boolean {
    return this.regionOrderCache.has(regionId);
  }

  /**
   * Resolves a station or structure location ID to its EVE region ID.
   * Results are cached in-memory. Returns undefined on failure.
   */
  public async resolveLocationRegionId(
    locationId: number,
  ): Promise<number | undefined> {
    const cached = this.locationRegionCache.get(locationId);
    if (cached !== undefined) return cached;

    try {
      let systemId: number | undefined;

      if (locationId >= 1_000_000_000_000) {
        // Player-owned structure — requires auth token.
        const token = await eveAuthService.getAccessToken();
        if (token) {
          const resp = await fetch(
            `https://esi.evetech.net/latest/universe/structures/${locationId}/?datasource=tranquility`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (resp.ok) {
            const data = (await resp.json()) as { solar_system_id: number };
            systemId = data.solar_system_id;
          }
        }
      } else {
        // NPC station — public endpoint.
        const resp = await fetch(
          `https://esi.evetech.net/latest/universe/stations/${locationId}/?datasource=tranquility`,
        );
        if (resp.ok) {
          const data = (await resp.json()) as { system_id: number };
          systemId = data.system_id;
        }
      }

      if (systemId !== undefined) {
        const regionId = await this.resolveSystemRegionId(systemId);
        if (regionId !== undefined) {
          this.locationRegionCache.set(locationId, regionId);
          return regionId;
        }
      }
    } catch {
      /* fall through */
    }

    return undefined;
  }

  private async resolveSystemRegionId(
    systemId: number,
  ): Promise<number | undefined> {
    const cached = this.systemRegionCache.get(systemId);
    if (cached !== undefined) return cached;

    try {
      const sysResp = await fetch(
        `https://esi.evetech.net/latest/universe/systems/${systemId}/?datasource=tranquility`,
      );
      if (!sysResp.ok) return undefined;
      const sys = (await sysResp.json()) as { constellation_id: number };

      const conResp = await fetch(
        `https://esi.evetech.net/latest/universe/constellations/${sys.constellation_id}/?datasource=tranquility`,
      );
      if (!conResp.ok) return undefined;
      const con = (await conResp.json()) as { region_id: number };

      this.systemRegionCache.set(systemId, con.region_id);
      return con.region_id;
    } catch {
      return undefined;
    }
  }

  /** Returns the highest buy-order price for a type in a region (sync, uses in-memory cache).
   * Pass systemId to restrict to orders physically located in that system. */
  public getHighestBuyPrice(
    regionId: number,
    typeId: number,
    systemId?: number,
  ): number | undefined {
    const orders = this.regionOrderCache.get(regionId) ?? [];
    let highest: number | undefined;
    for (const o of orders) {
      if (o.typeId === typeId && o.isBuyOrder) {
        if (systemId !== undefined && o.systemId !== systemId) continue;
        if (highest === undefined || o.price > highest) highest = o.price;
      }
    }
    return highest;
  }

  /** Returns the lowest sell-order price for a type in a region (sync, uses in-memory cache).
   * Pass systemId to restrict to orders physically located in that system. */
  public getLowestSellPrice(
    regionId: number,
    typeId: number,
    systemId?: number,
  ): number | undefined {
    const orders = this.regionOrderCache.get(regionId) ?? [];
    let lowest: number | undefined;
    for (const o of orders) {
      if (o.typeId === typeId && !o.isBuyOrder) {
        if (systemId !== undefined && o.systemId !== systemId) continue;
        if (lowest === undefined || o.price < lowest) lowest = o.price;
      }
    }
    return lowest;
  }

  /** Returns all cached orders for a region (sync — populated by fetchAndIndexRegion). */
  public getRegionOrders(regionId: number): GetMarketsRegionIdOrders200Ok[] {
    if (isMockModeEnabled()) return getMockOrders();
    return this.regionOrderCache.get(regionId) ?? [];
  }

  public async resolveSystemNameToId(
    systemName: string,
  ): Promise<number | undefined> {
    const trimmedName = systemName.trim();

    if (trimmedName.length === 0) {
      return undefined;
    }

    // Use hardcoded systems list instead of ESI API to avoid 400 errors
    const systemId = await systemsService.getSystemIdByName(trimmedName);
    return systemId;
  }

  public async getNames(ids: number[]): Promise<Record<number, string>> {
    if (ids.length === 0) {
      return {};
    }

    if (isMockModeEnabled()) {
      const mockNames = getMockLocationNames();
      const resolved: Record<number, string> = {};

      for (const id of ids) {
        resolved[id] = mockNames[id] ?? `ID ${id}`;
      }

      return resolved;
    }

    const uniqueMissingIds = Array.from(new Set(ids)).filter(
      (id) => !this.nameCache.has(id),
    );

    if (uniqueMissingIds.length > 0) {
      const chunks = this.chunk(uniqueMissingIds, 200);

      for (const chunkIds of chunks) {
        try {
          const names = await esiApiService.execute(
            "Resolve IDs to names",
            async () =>
              esiApiService.universeApi.postUniverseNames({
                // ESI expects an array in JSON body; cast keeps SDK typing without sending Set {}.
                ids: chunkIds as unknown as Set<number>,
                datasource: "tranquility",
              }),
          );

          for (const nameEntry of names) {
            this.nameCache.set(nameEntry.id, nameEntry.name);
          }
        } catch {
          // Fall back to per-ID lookup so one bad ID does not invalidate the whole chunk.
        }

        // Fill any IDs that were not returned by bulk lookup (common for some structure/station IDs).
        for (const id of chunkIds) {
          if (this.nameCache.has(id)) {
            continue;
          }

          const name = await this.resolveNameById(id);
          // Only cache successful resolutions — don't cache the fallback so we retry next time.
          if (name !== "<unknown player station>") {
            this.nameCache.set(id, name);
          }
        }
      }
    }

    const resolved: Record<number, string> = {};

    for (const id of ids) {
      resolved[id] = this.nameCache.get(id) ?? `ID ${id}`;
    }

    return resolved;
  }

  private async resolveNameById(id: number): Promise<string> {
    // Player-owned structure IDs are ≥ 1e12 — skip endpoints that don't support them.
    const isStructure = id >= 1_000_000_000_000;

    if (!isStructure) {
      // Try bulk universe names endpoint
      try {
        const names = await esiApiService.execute(
          `Resolve ID ${id} to name`,
          async () =>
            esiApiService.universeApi.postUniverseNames({
              ids: [id] as unknown as Set<number>,
              datasource: "tranquility",
            }),
        );

        const found = names.find((entry) => entry.id === id);
        if (found !== undefined) return found.name;
      } catch {
        // Continue to next fallback.
      }

      // Try station endpoint (for NPC stations)
      try {
        const station = await esiApiService.execute(
          `Get station ${id}`,
          async () =>
            esiApiService.universeApi.getUniverseStationsStationId({
              stationId: id,
              datasource: "tranquility",
            }),
        );
        return station.name;
      } catch {
        // Continue to next fallback.
      }
    }

    // Try structure endpoint (for player-owned structures) — requires auth even for public structures.
    try {
      const token = await eveAuthService.getAccessToken();
      if (token) {
        const url = `https://esi.evetech.net/latest/universe/structures/${id}/?datasource=tranquility`;
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        console.debug(`[structure] ${id} → ${resp.status}`);
        if (resp.ok) {
          const data = (await resp.json()) as { name: string };
          return data.name;
        } else {
          const body = await resp.text().catch(() => "");
          console.warn(`[structure] ${id} failed ${resp.status}:`, body);
        }
      } else {
        console.warn(`[structure] ${id} — no token available`);
      }
    } catch (err) {
      console.warn(`[structure] ${id} exception:`, err);
    }

    return "<unknown player station>";
  }

  private async loadTypeCacheFromStorage(): Promise<void> {
    try {
      const records = await typeCacheGetAll();
      const now = Date.now();
      for (const r of records) {
        // Skip records missing canBeAssembled — they pre-date this field and need a re-fetch.
        if (r.expiresAt > now && r.canBeAssembled !== undefined) {
          this.typeCache.set(r.typeId, {
            typeId: r.typeId,
            name: r.name,
            volumeM3: r.volumeM3,
            canBeAssembled: r.canBeAssembled,
          });
        }
      }
    } catch {
      /* IDB unavailable — start with empty cache */
    }
  }

  private saveTypeCacheToStorage(): void {
    const expiresAt = Date.now() + this.TYPE_CACHE_TTL_MS;
    const records = [...this.typeCache.entries()].map(([typeId, d]) => ({
      typeId,
      name: d.name,
      volumeM3: d.volumeM3,
      canBeAssembled: d.canBeAssembled,
      expiresAt,
    }));
    void typeCachePutBulk(records);
  }

  public async getTypeDetails(
    typeIds: number[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<number, TypeDetails>> {
    if (isMockModeEnabled()) {
      const mockMap = new Map<number, TypeDetails>();

      for (const typeId of typeIds) {
        const found = MOCK_TYPE_DETAILS.find(
          (entry) => entry.typeId === typeId,
        );

        if (found !== undefined) {
          mockMap.set(typeId, found);
        }
      }

      return mockMap;
    }

    const uniqueTypeIds = Array.from(new Set(typeIds));
    const missing = uniqueTypeIds.filter((id) => !this.typeCache.has(id));
    let done = uniqueTypeIds.length - missing.length; // already cached count
    const total = uniqueTypeIds.length;

    if (onProgress) onProgress(done, total);

    for (const typeId of missing) {
      const typeInfo = await esiApiService.execute(
        `Get type ${typeId}`,
        async () =>
          esiApiService.universeApi.getUniverseTypesTypeId({
            typeId,
            datasource: "tranquility",
            language: "en-us",
          }),
      );

      this.typeCache.set(typeId, {
        typeId,
        name: typeInfo.name,
        volumeM3: typeInfo.packagedVolume ?? typeInfo.volume ?? 0,
        // True only when packaged volume is meaningfully smaller than assembled volume.
        // ESI returns packagedVolume for all types; for modules/minerals it equals volume.
        canBeAssembled:
          typeInfo.packagedVolume !== undefined &&
          typeInfo.volume !== undefined &&
          typeInfo.packagedVolume < typeInfo.volume,
      });
      done++;
      if (onProgress) onProgress(done, total);
    }

    if (missing.length > 0) this.saveTypeCacheToStorage();

    const results = new Map<number, TypeDetails>();

    for (const typeId of uniqueTypeIds) {
      const value = this.typeCache.get(typeId);

      if (value !== undefined) {
        results.set(typeId, value);
      }
    }

    return results;
  }

  public async getSystemDetails(systemId: number): Promise<SystemDetails> {
    const cached = this.systemCache.get(systemId);

    if (cached !== undefined) {
      return cached;
    }

    const system = await esiApiService.execute(
      `Get system ${systemId}`,
      async () =>
        esiApiService.universeApi.getUniverseSystemsSystemId({
          systemId,
          datasource: "tranquility",
          language: "en-us",
        }),
    );

    const details: SystemDetails = {
      systemId: system.systemId,
      name: system.name,
      securityStatus: system.securityStatus,
      x: system.position.x,
      z: system.position.z,
    };

    this.systemCache.set(systemId, details);
    return details;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }

    return chunks;
  }
}

export const marketDataService = new MarketDataService();
