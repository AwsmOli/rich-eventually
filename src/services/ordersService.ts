/**
 * ordersService — polls a character's open + historical orders and wallet
 * transactions, detects fills, and computes sell-order profit.
 *
 * ESI endpoints used:
 *   GET /characters/{id}/assets/             — actual hangar contents (paged)
 *   GET /characters/{id}/orders/           — open orders only (paged)
 *   GET /characters/{id}/orders/history/   — recently completed/cancelled (paged)
 *   GET /characters/{id}/wallet/transactions/ — matched to buy history for avg price
 *
 * Polling interval: every 60 seconds while a character is authenticated.
 */

import { ref, watch } from "vue";

import { eveAuthService } from "./eveAuthService";
import { kvGet, kvSet } from "./idbService";
import { marketDataService } from "./marketDataService";
import { toastService } from "./toastService";

const ESI_BASE = "https://esi.evetech.net/latest";

// ── Domain types ──────────────────────────────────────────────────────────────

export type OrderState =
  | "open"
  | "closed"
  | "expired"
  | "cancelled"
  | "pending"
  | "character_deleted";

export interface CharacterOrder {
  orderId: number;
  typeId: number;
  typeName: string;
  /** true = buy order, false = sell order */
  isBuyOrder: boolean;
  price: number;
  volumeTotal: number;
  volumeRemain: number;
  locationId: number;
  systemId: number;
  regionId: number;
  issued: string; // ISO date
  /** Only on open orders */
  duration?: number;
  /** Escrow held for open buy orders (ISK locked up) */
  escrow?: number;
  /** Only on history orders */
  state?: OrderState;
  /** Computed profit for completed sell orders (sell proceeds minus last known buy cost) */
  estimatedProfit?: number;
}

export interface WalletTransaction {
  transactionId: number;
  typeId: number;
  /** true = buy, false = sell */
  isBuy: boolean;
  unitPrice: number;
  quantity: number;
  date: string;
}

export interface InventoryItem {
  typeId: number;
  typeName: string;
  locationId: number;
  /** regionId resolved from character's orders — undefined if location unknown */
  regionId: number | undefined;
  /** Unlisted quantity (bought − sold − currently listed on sell orders, distributed proportionally) */
  qty: number;
  avgBuyPrice: number;
  /** avg buy price × unlisted qty */
  totalCost: number;
  /** ISO date of the most recent buy transaction at this location */
  lastBuyDate: string;
  /** True for assembled ships and items inside fitted ships (cannot be directly sold as-is) */
  isAssembled: boolean;
}

// ── Service ───────────────────────────────────────────────────────────────────

class OrdersService {
  public readonly openOrders = ref<CharacterOrder[]>([]);
  public readonly orderHistory = ref<CharacterOrder[]>([]);
  public readonly inventoryItems = ref<InventoryItem[]>([]);
  public readonly isLoading = ref(false);
  public readonly lastUpdatedAt = ref<number | undefined>(undefined);
  /** Timestamp when ESI cache expires and fresh data becomes available. */
  public readonly esiExpiresAt = ref<number | undefined>(undefined);
  /** Character wallet balance in ISK — updated every poll. */
  public readonly walletBalance = ref<number | undefined>(undefined);
  /** Raw wallet transactions (buy + sell) — updated every poll. */
  public readonly walletTransactions = ref<WalletTransaction[]>([]);
  /** Total cost basis of all enriched inventory items — set by AssetsTab after enrichment. */
  public readonly totalAssetsValue = ref<number | undefined>(undefined);

  /** typeId → average buy price — built from wallet transactions */
  private readonly avgBuyPrice = new Map<number, number>();
  /** orderId → state on last poll — used to detect fills */
  private readonly prevStates = new Map<number, "open" | "closed">();
  /** typeId → displayName — filled lazily */
  private readonly nameCache = new Map<number, string>();

  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private marketPriceTimer: ReturnType<typeof setTimeout> | undefined;
  private isPolling = false;

  constructor() {
    // Polling is started externally (from OrdersPanel on mount / auth change).

    // When the tab wakes from sleep, the scheduled poll timer may have been
    // pending for hours. Re-poll immediately if data is stale.
    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        eveAuthService.character.value
      ) {
        const exp = this.esiExpiresAt.value;
        if (!this.isPolling && (!exp || Date.now() > exp)) {
          this.stopPolling();
          void this.poll();
        }
      }
    });

    // Whenever the market scanner finishes a region fetch, patch open order
    // prices from the in-memory cache — no extra ESI calls needed.
    watch(
      () => marketDataService.marketTick.value,
      () => { this.patchPricesFromCache(); },
    );

    // When the active character changes (switch or logout), clear stale data
    // and restart polling for the new character.
    watch(
      () => eveAuthService.character.value?.characterId,
      async (newId, oldId) => {
        if (newId === oldId) return;
        this.stopPolling();
        this.openOrders.value = [];
        this.orderHistory.value = [];
        this.inventoryItems.value = [];
        this.walletBalance.value = undefined;
        this.walletTransactions.value = [];
        this.prevStates.clear();
        if (newId !== undefined) {
          // Restore previously-cached history so Journal isn't empty while the poll runs.
          const cached = await kvGet<CharacterOrder[]>(
            `order-history-${newId}`,
          );
          if (cached) this.orderHistory.value = cached;
          void this.poll();
        }
      },
    );
  }

  // Vue `ref` doesn't expose `.subscribe` — watch via a micro-approach instead.
  // We call `startPolling()` from the component on mount / auth change.
  public startPolling(): void {
    if (this.pollTimer !== undefined || this.isPolling) return;
    void this.poll();
  }

  public stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.marketPriceTimer !== undefined) {
      clearTimeout(this.marketPriceTimer);
      this.marketPriceTimer = undefined;
    }
  }

  /**
   * Patches open order prices from the in-memory market cache (no ESI calls).
   * Called whenever marketTick increments (scanner finished a region).
   */
  private patchPricesFromCache(): void {
    const orders = this.openOrders.value;
    if (orders.length === 0) return;

    let changed = false;
    const patched = orders.map((o) => {
      const regionOrders = marketDataService.getRegionOrders(o.regionId);
      const m = regionOrders.find((r) => r.orderId === o.orderId);
      if (!m) return o; // not in cache yet — don't flag as filled
      if (m.price === o.price && m.volumeRemain === o.volumeRemain) return o;
      changed = true;
      return { ...o, price: m.price, volumeRemain: m.volumeRemain };
    });

    if (changed) this.openOrders.value = patched;
  }

  /**
   * Fetches public market orders for each (regionId, typeId) in the character's open
   * orders and patches price + volumeRemain from the 5-min-cached market data.
   * Also triggers an immediate character orders repoll when any orderId disappears
   * from the market (fill / cancellation / expiry detected early).
   */
  private async refreshOrderPrices(): Promise<void> {
    const orders = this.openOrders.value;
    if (orders.length === 0) return;

    // Group by regionId → Set of typeIds to minimise ESI calls.
    const byRegion = new Map<number, Set<number>>();
    for (const o of orders) {
      if (!o.regionId) continue;
      let types = byRegion.get(o.regionId);
      if (!types) {
        types = new Set();
        byRegion.set(o.regionId, types);
      }
      types.add(o.typeId);
    }

    // Collect all public market orders that match character order IDs.
    const marketById = new Map<
      number,
      { price: number; volumeRemain: number }
    >();
    let earliestExpiry: number | undefined;

    await Promise.all(
      [...byRegion.entries()].flatMap(([regionId, typeIds]) =>
        [...typeIds].map(async (typeId) => {
          try {
            const url =
              `${ESI_BASE}/markets/${regionId}/orders/?datasource=tranquility` +
              `&order_type=all&type_id=${typeId}`;
            const resp = await fetch(url, { cache: "no-cache" });
            if (!resp.ok) return;
            const expHeader = resp.headers.get("expires");
            if (expHeader) {
              const t = new Date(expHeader).getTime();
              if (!earliestExpiry || t < earliestExpiry) earliestExpiry = t;
            }
            const page = (await resp.json()) as Array<{
              order_id: number;
              price: number;
              volume_remain: number;
            }>;
            for (const m of page) {
              marketById.set(m.order_id, {
                price: m.price,
                volumeRemain: m.volume_remain,
              });
            }
          } catch {
            // non-fatal — stale data is fine
          }
        }),
      ),
    );

    // Patch open orders in-place and detect fills.
    let fillDetected = false;
    this.openOrders.value = this.openOrders.value.map((o) => {
      const m = marketById.get(o.orderId);
      if (!m) {
        // Order not found in the public market — likely filled, cancelled, or expired.
        fillDetected = true;
        return o;
      }
      if (m.price === o.price && m.volumeRemain === o.volumeRemain) return o;
      return { ...o, price: m.price, volumeRemain: m.volumeRemain };
    });

    // Update the displayed expiry time from the market Expires header.
    if (earliestExpiry !== undefined) this.esiExpiresAt.value = earliestExpiry;

    // Kick off a full character orders poll if a fill/cancel was detected.
    if (fillDetected && !this.isPolling) {
      void this.poll();
      return; // poll() will reschedule everything
    }

    // Reschedule the next market price refresh.
    // If no Expires header was received, retry in 30 s rather than stalling indefinitely.
    const delay = earliestExpiry
      ? Math.max(5_000, earliestExpiry - Date.now() + 2_000)
      : 30_000;
    this.marketPriceTimer = setTimeout(() => {
      this.marketPriceTimer = undefined;
      void this.refreshOrderPrices();
    }, delay);
  }

  private scheduleNext(expiresAt?: number): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    // Poll right when ESI's Expires header says cache is stale.
    // If the header was absent, retry in 30 s rather than stalling.
    const delay = expiresAt
      ? Math.max(5_000, expiresAt - Date.now() + 2_000)
      : 30_000;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll();
    }, delay);
  }

  public async poll(): Promise<void> {
    if (this.isPolling) return;
    if (!eveAuthService.character.value) return;

    // Set isPolling BEFORE the first await to prevent concurrent polls when
    // both AssetsTab and OrdersPanel call startPolling() simultaneously on mount.
    this.isPolling = true;
    this.isLoading.value = true;

    try {
      const token = await eveAuthService.getAccessToken();
      if (!token) return;

      const { characterId } = eveAuthService.character.value;

      const [rawAssets, rawOpen, rawHistory, rawTxns, walletRaw] =
        await Promise.all([
          this.fetchAllPages<EsiAsset>(
            `${ESI_BASE}/characters/${characterId}/assets/?datasource=tranquility`,
            token,
          ),
          this.fetchAllPages<EsiOrder>(
            `${ESI_BASE}/characters/${characterId}/orders/?datasource=tranquility`,
            token,
          ),
          this.fetchAllPages<EsiHistoryOrder>(
            `${ESI_BASE}/characters/${characterId}/orders/history/?datasource=tranquility`,
            token,
          ),
          this.fetchAllPages<EsiTransaction>(
            `${ESI_BASE}/characters/${characterId}/wallet/transactions/?datasource=tranquility`,
            token,
          ),
          fetch(
            `${ESI_BASE}/characters/${characterId}/wallet/?datasource=tranquility`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(15_000),
            },
          )
            .then((r) =>
              r.ok ? (r.json() as Promise<number>) : Promise.resolve(undefined),
            )
            .catch(() => undefined),
        ]);

      if (walletRaw !== undefined)
        this.walletBalance.value = walletRaw as number;

      // Drive the poll schedule from the open-orders endpoint only — it caches for ~5 min.
      // History caches for ~1h and transactions for ~30 min; including them in Math.min
      // would cause the schedule to slip to their longer expiry whenever rawOpen has no header.
      this.esiExpiresAt.value = rawOpen.expiresAt;

      // Build avg buy price map from transactions (buy side only, newest first).
      this.updateAvgBuyPrices(rawTxns.data);
      this.walletTransactions.value = rawTxns.data.map((t) => ({
        transactionId: t.transaction_id,
        typeId: t.type_id,
        isBuy: t.is_buy,
        unitPrice: t.unit_price,
        quantity: t.quantity,
        date: t.date,
        locationId: t.location_id,
      }));

      // Collect all typeIds that need names.
      const allTypeIds = new Set<number>([
        ...rawAssets.data.map((a) => a.type_id),
        ...rawOpen.data.map((o) => o.type_id),
        ...rawHistory.data.map((o) => o.type_id),
      ]);
      await this.resolveNames([...allTypeIds], token);

      // Map open orders.
      const newOpen: CharacterOrder[] = rawOpen.data.map((o) =>
        this.mapOpen(o),
      );

      // Detect fills: orders that were open last poll but are now gone from open list.
      const newOpenIds = new Set(newOpen.map((o) => o.orderId));
      for (const [orderId, prevState] of this.prevStates) {
        if (prevState === "open" && !newOpenIds.has(orderId)) {
          const hist = rawHistory.data.find((h) => h.order_id === orderId);
          if (hist && hist.state === "closed") {
            const name =
              this.nameCache.get(hist.type_id) ?? `Type ${hist.type_id}`;
            const side = hist.is_buy_order ? "Buy" : "Sell";
            toastService.push(
              `${side} order filled: ${hist.volume_total.toLocaleString()} × ${name}`,
              "success",
              10_000,
            );
          }
        }
      }

      // Refresh prev-states map.
      this.prevStates.clear();
      for (const o of newOpen) this.prevStates.set(o.orderId, "open");

      // Map history orders with estimated profit for closed sell orders.
      const newHistory: CharacterOrder[] = rawHistory.data.map((o) =>
        this.mapHistory(o),
      );

      this.openOrders.value = newOpen;
      this.orderHistory.value = newHistory;
      void kvSet(`order-history-${characterId}`, newHistory);
      this.inventoryItems.value = this.computeInventoryFromAssets(
        rawAssets.data,
        rawTxns.data,
        newOpen,
        newHistory,
      );
      this.totalAssetsValue.value = this.inventoryItems.value.reduce(
        (s, i) => s + i.totalCost,
        0,
      );
      this.lastUpdatedAt.value = Date.now();

      // Persist a net-worth snapshot (wallet + cost-basis inventory) to IDB.
      // One snapshot per day; older than 90 days are pruned.
      if (walletRaw !== undefined) {
        const wallet = walletRaw as number;
        const assets = this.totalAssetsValue.value ?? 0;
        void this.saveNetworthSnapshot(wallet + assets);
      }
    } catch (err) {
      console.error("Orders poll failed:", err);
    } finally {
      this.isLoading.value = false;
      this.isPolling = false;
      this.scheduleNext(this.esiExpiresAt.value);
      // Also kick off the 5-min market price refresh (cancels any previous one).
      if (this.marketPriceTimer !== undefined) {
        clearTimeout(this.marketPriceTimer);
        this.marketPriceTimer = undefined;
      }
      if (this.openOrders.value.length > 0) {
        const delay = this.esiExpiresAt.value
          ? Math.max(5_000, this.esiExpiresAt.value - Date.now() + 2_000)
          : 30_000;
        this.marketPriceTimer = setTimeout(() => {
          this.marketPriceTimer = undefined;
          void this.refreshOrderPrices();
        }, delay);
      }
    }
  }

  private computeInventoryFromAssets(
    assets: EsiAsset[],
    txns: EsiTransaction[],
    openOrders: CharacterOrder[],
    historyOrders: CharacterOrder[],
  ): InventoryItem[] {
    // Build locationId -> regionId map from character's orders.
    const locationRegion = new Map<number, number>();
    for (const o of [...openOrders, ...historyOrders]) {
      locationRegion.set(o.locationId, o.regionId);
    }

    // Only consider stackable items sitting directly in a station/structure hangar.
    // Assembled (singleton) items cannot be directly sold, so skip them.
    const flagCounts = assets.reduce<Record<string, number>>((acc, a) => {
      acc[a.location_flag] = (acc[a.location_flag] ?? 0) + 1;
      return acc;
    }, {});
    console.debug("[assets] total:", assets.length, "flags:", flagCounts);

    // Build item_id → station_id for docked ships (singletons in Hangar).
    // Fitted modules have location_id = ship item_id, so we need this to resolve their station.
    const shipToStation = new Map<number, number>();
    for (const a of assets) {
      if (a.is_singleton && a.location_flag === "Hangar") {
        shipToStation.set(a.item_id, a.location_id);
      }
    }

    // Slot flags that indicate an item is inside a ship.
    const FITTED_FLAGS = new Set([
      "Cargo",
      "DroneBay",
      "FighterBay",
      "HiSlot0",
      "HiSlot1",
      "HiSlot2",
      "HiSlot3",
      "HiSlot4",
      "HiSlot5",
      "HiSlot6",
      "HiSlot7",
      "MedSlot0",
      "MedSlot1",
      "MedSlot2",
      "MedSlot3",
      "MedSlot4",
      "MedSlot5",
      "MedSlot6",
      "MedSlot7",
      "LoSlot0",
      "LoSlot1",
      "LoSlot2",
      "LoSlot3",
      "LoSlot4",
      "LoSlot5",
      "LoSlot6",
      "LoSlot7",
      "RigSlot0",
      "RigSlot1",
      "RigSlot2",
      "SubSystemSlot0",
      "SubSystemSlot1",
      "SubSystemSlot2",
      "SubSystemSlot3",
    ]);

    // Collect all relevant items with a resolved station location_id.
    type FlatItem = {
      typeId: number;
      locationId: number;
      quantity: number;
      isAssembled: boolean;
    };
    const flatItems: FlatItem[] = [];

    for (const a of assets) {
      if (a.location_flag === "Hangar") {
        // Stackable hangar items and ships (singletons = qty 1 each).
        flatItems.push({
          typeId: a.type_id,
          locationId: a.location_id,
          quantity: a.is_singleton ? 1 : a.quantity,
          isAssembled: a.is_singleton,
        });
      } else if (FITTED_FLAGS.has(a.location_flag)) {
        // Module/cargo inside a ship — resolve location via the ship's station.
        const stationId = shipToStation.get(a.location_id);
        if (stationId !== undefined) {
          flatItems.push({
            typeId: a.type_id,
            locationId: stationId,
            quantity: a.quantity,
            isAssembled: true,
          });
        }
      }
    }
    console.debug(
      "[assets] flat items (incl ships+modules):",
      flatItems.length,
    );

    // Items currently listed on open sell orders per (typeId:locationId).
    const listedQty = new Map<string, number>();
    for (const o of openOrders) {
      if (o.isBuyOrder) continue;
      const key = `${o.typeId}:${o.locationId}`;
      listedQty.set(key, (listedQty.get(key) ?? 0) + o.volumeRemain);
    }

    // Build weighted avg buy price and last buy date per typeId from transactions.
    type BuyInfo = { totalCost: number; totalQty: number; lastDate: string };
    const buyInfo = new Map<number, BuyInfo>();
    for (const t of txns) {
      if (!t.is_buy) continue;
      let b = buyInfo.get(t.type_id);
      if (!b) {
        b = { totalCost: 0, totalQty: 0, lastDate: t.date };
        buyInfo.set(t.type_id, b);
      }
      b.totalCost += t.unit_price * t.quantity;
      b.totalQty += t.quantity;
      if (t.date > b.lastDate) b.lastDate = t.date;
    }

    // Fall back to closed/expired buy orders in history for types not covered by transactions
    // (transactions only go back ~2500 entries; history orders go back much further).
    const histBuyOrders = historyOrders.filter(
      (o) => o.isBuyOrder && (o.state === "closed" || o.state === "expired"),
    );
    console.debug(
      "[assets] history buy orders:",
      histBuyOrders.length,
      "states:",
      [
        ...new Set(
          historyOrders.filter((o) => o.isBuyOrder).map((o) => o.state),
        ),
      ],
    );
    for (const o of histBuyOrders) {
      if (buyInfo.has(o.typeId)) continue; // transactions already cover this type
      const filledQty = o.volumeTotal - o.volumeRemain;
      if (filledQty <= 0) continue;
      let b = buyInfo.get(o.typeId);
      if (!b) {
        b = { totalCost: 0, totalQty: 0, lastDate: o.issued };
        buyInfo.set(o.typeId, b);
      }
      b.totalCost += o.price * filledQty;
      b.totalQty += filledQty;
      if (o.issued > b.lastDate) b.lastDate = o.issued;
    }
    console.debug(
      "[assets] buyInfo types after history fallback:",
      buyInfo.size,
    );

    // Aggregate multiple stacks of the same (typeId, locationId) into one.
    const stackMap = new Map<
      string,
      {
        typeId: number;
        locationId: number;
        quantity: number;
        isAssembled: boolean;
      }
    >();
    for (const asset of flatItems) {
      const key = `${asset.typeId}:${asset.locationId}:${asset.isAssembled ? "1" : "0"}`;
      const existing = stackMap.get(key);
      if (existing) {
        existing.quantity += asset.quantity;
      } else {
        stackMap.set(key, {
          typeId: asset.typeId,
          locationId: asset.locationId,
          quantity: asset.quantity,
          isAssembled: asset.isAssembled,
        });
      }
    }

    const result: InventoryItem[] = [];
    for (const {
      typeId,
      locationId,
      quantity,
      isAssembled,
    } of stackMap.values()) {
      // For assembled items (ships/fitted modules) don't subtract listed sell orders —
      // they can't be listed as stacks anyway.
      const listed = isAssembled
        ? 0
        : (listedQty.get(`${typeId}:${locationId}`) ?? 0);
      const unlistedQty = quantity - listed;
      if (unlistedQty <= 0) continue;

      const info = buyInfo.get(typeId);
      const avgBuyPrice =
        info && info.totalQty > 0 ? info.totalCost / info.totalQty : 0;
      const lastBuyDate = info?.lastDate ?? new Date(0).toISOString();

      result.push({
        typeId,
        typeName: this.nameCache.get(typeId) ?? `Type ${typeId}`,
        locationId,
        regionId: locationRegion.get(locationId),
        qty: unlistedQty,
        avgBuyPrice,
        totalCost: avgBuyPrice * unlistedQty,
        lastBuyDate,
        isAssembled,
      });
    }

    console.debug("[assets] result items:", result.length);
    return result.sort((a, b) => b.totalCost - a.totalCost);
  }

  // ── Mapping ──────────────────────────────────────────────────────────────

  private mapOpen(o: EsiOrder): CharacterOrder {
    return {
      orderId: o.order_id,
      typeId: o.type_id,
      typeName: this.nameCache.get(o.type_id) ?? `Type ${o.type_id}`,
      isBuyOrder: o.is_buy_order,
      price: o.price,
      volumeTotal: o.volume_total,
      volumeRemain: o.volume_remain,
      locationId: o.location_id,
      systemId: o.system_id,
      regionId: o.region_id,
      issued: o.issued,
      duration: o.duration,
      escrow: o.escrow,
    };
  }

  private mapHistory(o: EsiHistoryOrder): CharacterOrder {
    const filled = o.volume_total - (o.volume_remain ?? 0);
    let estimatedProfit: number | undefined;
    // Compute profit for any sell order that had volume filled (closed, expired, or cancelled).
    if (!o.is_buy_order && filled > 0) {
      const avgBuy = this.avgBuyPrice.get(o.type_id);
      if (avgBuy !== undefined) {
        estimatedProfit = (o.price - avgBuy) * filled;
      }
    }
    return {
      orderId: o.order_id,
      typeId: o.type_id,
      typeName: this.nameCache.get(o.type_id) ?? `Type ${o.type_id}`,
      isBuyOrder: o.is_buy_order,
      price: o.price,
      volumeTotal: o.volume_total,
      volumeRemain: o.volume_remain ?? 0,
      locationId: o.location_id,
      systemId: 0, // ESI history orders don't include system_id
      regionId: o.region_id,
      issued: o.issued,
      state: o.state,
      estimatedProfit,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private updateAvgBuyPrices(txns: EsiTransaction[]): void {
    // Simple moving average: newest transactions last, keyed by typeId.
    const buckets = new Map<number, { total: number; count: number }>();
    for (const t of txns) {
      if (!t.is_buy) continue;
      let b = buckets.get(t.type_id);
      if (!b) {
        b = { total: 0, count: 0 };
        buckets.set(t.type_id, b);
      }
      b.total += t.unit_price * t.quantity;
      b.count += t.quantity;
    }
    for (const [typeId, { total, count }] of buckets) {
      this.avgBuyPrice.set(typeId, total / count);
    }
  }

  private async resolveNames(typeIds: number[], token: string): Promise<void> {
    const missing = typeIds.filter((id) => !this.nameCache.has(id));
    if (missing.length === 0) return;

    // ESI names endpoint accepts up to 1000 IDs per request.
    for (let i = 0; i < missing.length; i += 1000) {
      const batch = missing.slice(i, i + 1000);
      try {
        const resp = await fetch(
          `${ESI_BASE}/universe/names/?datasource=tranquility`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(batch),
          },
        );
        if (!resp.ok) continue;
        const names = (await resp.json()) as { id: number; name: string }[];
        for (const { id, name } of names) this.nameCache.set(id, name);
      } catch {
        /* non-fatal */
      }
    }
  }

  private async fetchAllPages<T>(
    baseUrl: string,
    token: string,
  ): Promise<{ data: T[]; expiresAt: number | undefined }> {
    const firstResp = await fetch(
      `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}page=1`,
      {
        cache: "no-cache",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!firstResp.ok) {
      if (firstResp.status === 403 || firstResp.status === 401) {
        console.warn(
          `[fetchAllPages] ${firstResp.status} from ${baseUrl} — missing scope?`,
        );
        return { data: [], expiresAt: undefined };
      }
      throw new Error(`ESI ${firstResp.status} from ${baseUrl}`);
    }

    // Parse ESI's Expires header so we know when to poll next for fresh data.
    const expiresHeader = firstResp.headers.get("expires");
    const expiresAt = expiresHeader
      ? new Date(expiresHeader).getTime()
      : undefined;

    const xPages = Number.parseInt(firstResp.headers.get("x-pages") ?? "1", 10);
    const first = (await firstResp.json()) as T[];
    if (xPages <= 1) return { data: first, expiresAt };

    const rest = await Promise.all(
      Array.from({ length: xPages - 1 }, (_, i) =>
        fetch(`${baseUrl}${baseUrl.includes("?") ? "&" : "?"}page=${i + 2}`, {
          cache: "no-cache",
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) =>
          r.ok ? (r.json() as Promise<T[]>) : Promise.resolve([] as T[]),
        ),
      ),
    );
    return { data: [first, ...rest].flat(), expiresAt };
  }

  private async saveNetworthSnapshot(value: number): Promise<void> {
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const key = "networth-snapshots";
    const existing =
      (await kvGet<Array<{ date: string; value: number }>>(key)) ?? [];
    // Update today's entry or append; keep latest 90 days.
    const idx = existing.findIndex((s) => s.date === today);
    if (idx >= 0) {
      existing[idx].value = value;
    } else {
      existing.push({ date: today, value });
    }
    const pruned = existing.slice(-90);
    await kvSet(key, pruned);
  }

  public onAuthChange(): void {
    if (eveAuthService.character.value) {
      this.startPolling();
    } else {
      this.stopPolling();
      this.openOrders.value = [];
      this.orderHistory.value = [];
      this.inventoryItems.value = [];
    }
  }
}

// ── ESI raw types ─────────────────────────────────────────────────────────────

interface EsiAsset {
  item_id: number;
  type_id: number;
  location_id: number;
  location_flag: string;
  quantity: number;
  is_singleton: boolean;
}

interface EsiOrder {
  order_id: number;
  type_id: number;
  is_buy_order: boolean;
  price: number;
  volume_total: number;
  volume_remain: number;
  location_id: number;
  region_id: number;
  issued: string;
  duration: number;
  escrow?: number;
  system_id: number;
}

interface EsiHistoryOrder {
  order_id: number;
  type_id: number;
  is_buy_order: boolean;
  price: number;
  volume_total: number;
  volume_remain?: number;
  location_id: number;
  region_id: number;
  issued: string;
  state: OrderState;
}

interface EsiTransaction {
  transaction_id: number;
  type_id: number;
  is_buy: boolean;
  unit_price: number;
  quantity: number;
  date: string;
  location_id: number;
}

export const ordersService = new OrdersService();
