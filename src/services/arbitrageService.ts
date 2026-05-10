import { ref } from "vue";

import type { GetMarketsRegionIdOrders200Ok } from "@evespace/esi-client";

import type {
  ArbitrageFilters,
  ArbitrageQueryResult,
  MarketOpportunity,
  ResolvedFilters,
  TypeDetails,
} from "../types/domain";

import { marketDataService } from "./marketDataService";
import { routeService } from "./routeService";

// Must match the page limit used by marketScannerService so cache keys align.
// REMOVED: page limit is no longer capped — the background scanner fetches all pages.

// Major high-sec EVE Online regions (verified IDs via ESI)
export const MAJOR_REGIONS = [
  10000002, // The Forge (Jita)
  10000033, // The Citadel
  10000016, // Lonetrek
  10000043, // Domain (Amarr)
  10000052, // Kador
  10000049, // Khanid
  10000065, // Kor-Azor
  10000020, // Tash-Murkon
  10000067, // Genesis
  10000030, // Heimatar (Rens)
  10000042, // Metropolis (Hek)
  10000028, // Molden Heath
  10000064, // Essence
  10000032, // Sinq Laison (Dodixie)
  10000037, // Everyshore
  10000048, // Placid
  10000068, // Verge Vendor
  10000036, // Devoid
];

// System ID → region ID for the 5 major trade hubs.
const HUB_SYSTEM_TO_REGION: Record<number, number> = {
  30000142: 10000002, // Jita → The Forge
  30002187: 10000043, // Amarr → Domain
  30002659: 10000032, // Dodixie → Sinq Laison
  30002510: 10000042, // Hek → Metropolis
  30004588: 10000030, // Rens → Heimatar
};

// Representative hub/anchor systems used for coarse region reachability checks.
// Regions without an anchor are never prefiltered (always kept).
const REGION_ANCHOR_SYSTEMS: Partial<Record<number, number>> = {
  10000002: 30000142, // The Forge -> Jita
  10000033: 30000144, // The Citadel -> Perimeter
  10000043: 30002187, // Domain -> Amarr
  10000032: 30002659, // Sinq Laison -> Dodixie
  10000042: 30002510, // Metropolis -> Hek
  10000030: 30004588, // Heimatar -> Rens
};

// Major trade hub systems. When no explicit destination is set, buy orders are
// restricted to these systems so we only ever look for "buy cheap → sell at hub" deals.
const TRADE_HUB_SYSTEM_IDS = new Set([
  30000142, // Jita
  30002187, // Amarr
  30002659, // Dodixie
  30002510, // Hek
  30004588, // Rens
]);

interface CandidateOpportunity {
  typeId: number;
  units: number;
  buyOrder: GetMarketsRegionIdOrders200Ok;
  sellOrder: GetMarketsRegionIdOrders200Ok;
  typeDetails: TypeDetails;
  grossProfit: number;
  netProfit: number;
  investment: number;
  cargoM3: number;
  salesTaxRate: number;
  bestSellPriceAtBuyLocation: number | undefined;
}

class ArbitrageService {
  /** Reactive progress for the current findOpportunities run. Undefined when idle. */
  public readonly analyzeProgress = ref<
    { step: string; current: number; total: number } | undefined
  >(undefined);

  public async findOpportunities(
    filters: ArbitrageFilters,
  ): Promise<ArbitrageQueryResult> {
    const warnings: string[] = [];
    this.analyzeProgress.value = {
      step: "Resolving filters…",
      current: 0,
      total: 1,
    };
    const resolvedFilters = await this.resolveFilters(filters, warnings);

    // Fetch market data from all selected regions, then build candidates across the combined orderbook.
    // When a destination is set but no source is restricted, scan all regions automatically —
    // the background scanner already has all region data and the user wants the best source anywhere.
    const baseRegionsToScan =
      filters.scanAllRegions ||
      (resolvedFilters.toSystemId !== undefined &&
        resolvedFilters.fromSystemId === undefined)
        ? MAJOR_REGIONS
        : [resolvedFilters.regionId];
    const regionsToScan = await this.prefilterRegionsByJumpReach(
      baseRegionsToScan,
      resolvedFilters,
      warnings,
    );
    this.analyzeProgress.value = {
      step: "Reading cached orders…",
      current: 0,
      total: regionsToScan.length,
    };
    const combinedOrders: GetMarketsRegionIdOrders200Ok[] = [];

    for (const regionId of regionsToScan) {
      const orders = marketDataService.getRegionOrders(regionId);
      for (const order of orders) combinedOrders.push(order);
      this.analyzeProgress.value = {
        ...this.analyzeProgress.value!,
        current: this.analyzeProgress.value!.current + 1,
      };
    }

    this.analyzeProgress.value = {
      step: "Building candidates…",
      current: 0,
      total: 1,
    };
    const allCandidates = await this.buildCandidates(
      combinedOrders,
      resolvedFilters,
      regionsToScan.length,
    );

    // Filter by 90-day average daily trade count in The Forge (Jita) as liquidity proxy.
    let filteredCandidates = allCandidates;
    if (resolvedFilters.minAvgDailyIskVolume > 0) {
      this.analyzeProgress.value = {
        step: "Checking liquidity…",
        current: 0,
        total: new Set(allCandidates.map((c) => c.typeId)).size,
      };
      filteredCandidates = await this.filterByLiquidity(
        allCandidates,
        resolvedFilters.minAvgDailyIskVolume,
        (done, total) => {
          this.analyzeProgress.value = {
            step: "Checking liquidity…",
            current: done,
            total,
          };
        },
      );
    }

    const topCandidates = filteredCandidates
      .sort((left, right) => right.netProfit - left.netProfit)
      .slice(0, resolvedFilters.maxRoutesToEvaluate);

    // Resolve cheapest destination sell price for each candidate via targeted ESI calls.
    const uniqueTypeCount = new Set(topCandidates.map((c) => c.typeId)).size;
    this.analyzeProgress.value = {
      step: "Fetching destination prices…",
      current: 0,
      total: uniqueTypeCount,
    };
    await this.resolveBestSellPrices(topCandidates);

    // Compute avg daily trade count in the sell-to region for display.
    this.analyzeProgress.value = {
      step: "Fetching trade history…",
      current: 0,
      total: topCandidates.length,
    };
    const { tradeCounts: tradeCountByKey, avgPrices: avg90dPriceByType } =
      await this.computeTradeCountsForCandidates(topCandidates, (done) => {
        this.analyzeProgress.value = {
          step: "Fetching trade history…",
          current: done,
          total: topCandidates.length,
        };
      });

    const locationIds = new Set<number>();

    for (const candidate of topCandidates) {
      locationIds.add(candidate.buyOrder.locationId);
      locationIds.add(candidate.sellOrder.locationId);
    }

    const locationNames = await marketDataService.getNames([...locationIds]);
    const opportunities: MarketOpportunity[] = [];
    this.analyzeProgress.value = {
      step: "Calculating routes…",
      current: 0,
      total: topCandidates.length,
    };
    let routesDone = 0;

    for (const candidate of topCandidates) {
      const route = await routeService.getRoute(
        candidate.buyOrder.systemId,
        candidate.sellOrder.systemId,
        resolvedFilters.avoidSystemIds,
        resolvedFilters.routeSecurity,
      );

      if (route.jumps > resolvedFilters.maxJumps) {
        continue;
      }

      const opportunity = this.toOpportunity(
        candidate,
        route.jumps,
        locationNames,
        route.originName,
        route.destinationName,
        tradeCountByKey.get(
          `${candidate.typeId}:${candidate.buyOrder.systemId}`,
        ) ?? 0,
        avg90dPriceByType.get(candidate.typeId),
        resolvedFilters.brokerFeeRate,
      );

      opportunities.push({
        ...opportunity,
        route,
      });
      routesDone++;
      this.analyzeProgress.value = {
        step: "Calculating routes…",
        current: routesDone,
        total: topCandidates.length,
      };
    }

    opportunities.sort(
      (left, right) => right.profitPerJump - left.profitPerJump,
    );

    this.analyzeProgress.value = undefined;
    return {
      opportunities,
      warnings,
      fetchedAt: Date.now(),
    };
  }

  private async computeTradeCountsForCandidates(
    candidates: CandidateOpportunity[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{
    tradeCounts: Map<string, number>;
    avgPrices: Map<number, number | undefined>;
  }> {
    const pairs = [
      ...new Set(candidates.map((c) => `${c.typeId}:${c.buyOrder.systemId}`)),
    ];
    const tradeCounts = new Map<string, number>();
    const avgPrices = new Map<number, number | undefined>();
    let done = 0;

    await Promise.all(
      pairs.map(async (key) => {
        const [typeIdStr, systemIdStr] = key.split(":");
        const typeId = Number(typeIdStr);
        const systemId = Number(systemIdStr);
        const regionId = HUB_SYSTEM_TO_REGION[systemId] ?? 10000002;
        try {
          const { avgOrderCount, avgPrice } =
            await marketDataService.getHistorySummary(regionId, typeId);
          tradeCounts.set(key, avgOrderCount);
          if (!avgPrices.has(typeId)) avgPrices.set(typeId, avgPrice);
        } catch {
          tradeCounts.set(key, 0);
          if (!avgPrices.has(typeId)) avgPrices.set(typeId, undefined);
        }
        done++;
        onProgress?.(done, pairs.length);
      }),
    );

    return { tradeCounts, avgPrices };
  }

  private async filterByLiquidity(
    candidates: CandidateOpportunity[],
    minAvgDailyIsk: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<CandidateOpportunity[]> {
    const JITA_REGION = 10000002;
    const uniqueTypeIds = [...new Set(candidates.map((c) => c.typeId))];

    const avgIskByType = new Map<number, number>();
    let done = 0;
    await Promise.all(
      uniqueTypeIds.map(async (typeId) => {
        try {
          const { avgOrderCount } = await marketDataService.getHistorySummary(
            JITA_REGION,
            typeId,
          );
          avgIskByType.set(typeId, avgOrderCount);
        } catch {
          avgIskByType.set(typeId, 0);
        }
        done++;
        onProgress?.(done, uniqueTypeIds.length);
      }),
    );

    return candidates.filter(
      (c) => (avgIskByType.get(c.typeId) ?? 0) >= minAvgDailyIsk,
    );
  }

  private async prefilterRegionsByJumpReach(
    regionIds: number[],
    filters: ResolvedFilters,
    warnings: string[],
  ): Promise<number[]> {
    if (filters.toSystemId === undefined || filters.maxJumps <= 0) {
      return regionIds;
    }

    const kept: number[] = [];
    const skipped: number[] = [];

    for (const regionId of regionIds) {
      const anchorSystemId = REGION_ANCHOR_SYSTEMS[regionId];

      // No safe anchor for this region: do not prefilter it.
      if (anchorSystemId === undefined) {
        kept.push(regionId);
        continue;
      }

      if (anchorSystemId === filters.toSystemId) {
        kept.push(regionId);
        continue;
      }

      try {
        const route = await routeService.getRoute(
          anchorSystemId,
          filters.toSystemId,
          filters.avoidSystemIds,
          "shortest",
        );

        if (route.jumps <= filters.maxJumps) {
          kept.push(regionId);
        } else {
          skipped.push(regionId);
        }
      } catch {
        // If reachability probe fails, keep region to avoid false negatives.
        kept.push(regionId);
      }
    }

    if (skipped.length > 0) {
      warnings.push(
        `Skipped ${skipped.length} far region(s) using max jumps ${filters.maxJumps} and destination reachability prefilter.`,
      );
    }

    return kept;
  }

  private async resolveFilters(
    filters: ArbitrageFilters,
    warnings: string[],
  ): Promise<ResolvedFilters> {
    const fromSystemId = await this.resolveNamedSystem(
      filters.fromSystemName,
      "from",
      warnings,
    );
    const toSystemId = await this.resolveNamedSystem(
      filters.toSystemName,
      "to",
      warnings,
    );

    const avoidNames = filters.avoidSystemsInput
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    const avoidSystemIds: number[] = [];

    for (const name of avoidNames) {
      const systemId = await marketDataService.resolveSystemNameToId(name);

      if (systemId === undefined) {
        warnings.push(`Could not resolve avoided system "${name}".`);
        continue;
      }

      avoidSystemIds.push(systemId);
    }

    return {
      regionId: filters.regionId,
      fromSystemId,
      toSystemId,
      avoidSystemIds,
      maxCargoHold: filters.maxCargoHold,
      maxInvestment: filters.maxInvestment,
      maxJumps: filters.maxJumps,
      routeSecurity: filters.routeSecurity,
      accountingLevel: Math.max(
        0,
        Math.min(5, Math.floor(filters.accountingLevel)),
      ),
      brokerFeeRate: Math.max(
        0,
        Math.min(0.1, (filters.brokerFeePercent ?? 3) / 100),
      ),
      maxRoutesToEvaluate: Math.max(
        5,
        Math.min(500, Math.floor(filters.maxRoutesToEvaluate)),
      ),
      minAvgDailyIskVolume: Math.max(0, filters.minAvgDailyTradeCount),
    };
  }

  private async resolveNamedSystem(
    name: string,
    mode: "from" | "to",
    warnings: string[],
  ): Promise<number | undefined> {
    const trimmed = name.trim();

    if (trimmed.length === 0) {
      return undefined;
    }

    const id = await marketDataService.resolveSystemNameToId(trimmed);

    if (id === undefined) {
      warnings.push(`Could not resolve ${mode} system "${trimmed}".`);
    }

    return id;
  }

  private async buildCandidates(
    orders: GetMarketsRegionIdOrders200Ok[],
    filters: ResolvedFilters,
    regionCount: number,
  ): Promise<CandidateOpportunity[]> {
    // Scale the per-type sell pool with the number of regions scanned. A global cap of 20
    // lets cheap far-away sell orders (from farther regions) crowd out nearby ones that
    // would survive the per-route maxJumps filter. Cap at 300 to keep pair-building fast.
    const TOP_ORDERS_PER_SIDE = Math.min(20 * Math.max(1, regionCount), 300);
    const TOP_PAIRS_PER_TYPE = 6;
    // When destination is set, keep separate pools so Jita sell orders don't crowd
    // out non-Jita sell orders. This ensures both station trades (dest sell + dest buy)
    // and hauling trades (non-dest sell + dest buy) are always represented.
    const topSellsAtDestByType = new Map<
      number,
      GetMarketsRegionIdOrders200Ok[]
    >();
    const topSellsElsewhereByType = new Map<
      number,
      GetMarketsRegionIdOrders200Ok[]
    >();
    const topBuysByType = new Map<number, GetMarketsRegionIdOrders200Ok[]>();

    const trimTopOrders = (
      target: Map<number, GetMarketsRegionIdOrders200Ok[]>,
      typeId: number,
      order: GetMarketsRegionIdOrders200Ok,
      sortBy: "asc" | "desc",
    ): void => {
      const list = target.get(typeId) ?? [];

      list.push(order);
      list.sort((left, right) => {
        if (sortBy === "asc") {
          return left.price - right.price;
        }

        return right.price - left.price;
      });

      if (list.length > TOP_ORDERS_PER_SIDE) {
        list.length = TOP_ORDERS_PER_SIDE;
      }

      target.set(typeId, list);
    };

    // Pass 1: build destination demand (buy side).
    // When a destination is set, use only that system's buy orders.
    // When no destination, restrict to major trade hubs so we only find
    // "buy cheap elsewhere → sell at trade hub" deals, never the reverse.
    for (const order of orders) {
      if (!order.isBuyOrder) {
        continue;
      }

      if (filters.toSystemId !== undefined) {
        if (order.systemId !== filters.toSystemId) continue;
      } else {
        if (!TRADE_HUB_SYSTEM_IDS.has(order.systemId)) continue;
      }

      trimTopOrders(topBuysByType, order.typeId, order, "desc");
    }

    // Only look at sell orders for types that actually have hub-side demand.
    // This prune is always valid now since buy orders are always restricted to trade hubs.
    const demandedTypeIds = new Set<number>(topBuysByType.keys());

    // Pass 2: collect source supply (sell side), optionally restricted to demanded types.
    // Split into at-destination and elsewhere pools to prevent one crowding out the other.
    for (const order of orders) {
      if (order.isBuyOrder) {
        continue;
      }

      if (
        filters.fromSystemId !== undefined &&
        order.systemId !== filters.fromSystemId
      ) {
        continue;
      }

      if (!demandedTypeIds.has(order.typeId)) {
        continue;
      }

      const isAtHub =
        filters.toSystemId !== undefined
          ? order.systemId === filters.toSystemId
          : TRADE_HUB_SYSTEM_IDS.has(order.systemId);
      trimTopOrders(
        isAtHub ? topSellsAtDestByType : topSellsElsewhereByType,
        order.typeId,
        order,
        "asc",
      );

      // Track sell orders by location+type for later lookup — only source-side
      // (destination sell prices are captured in Pass 3 without fromSystemId filter).
    }

    // Pass 3 removed: destination sell prices are now resolved via targeted ESI calls
    // (getCheapestSellPrice) after candidates are built, avoiding page-limit gaps.

    const spreadCandidates: Array<{
      typeId: number;
      buyOrder: GetMarketsRegionIdOrders200Ok;
      sellOrder: GetMarketsRegionIdOrders200Ok;
      units: number;
      spread: number;
    }> = [];

    // Merge both sell pools per type when building pairs.
    const allSellTypeIds = new Set([
      ...topSellsAtDestByType.keys(),
      ...topSellsElsewhereByType.keys(),
    ]);

    for (const typeId of allSellTypeIds) {
      const buyOrders = topBuysByType.get(typeId);

      if (buyOrders === undefined || buyOrders.length === 0) {
        continue;
      }

      const sellOrders = [
        ...(topSellsAtDestByType.get(typeId) ?? []),
        ...(topSellsElsewhereByType.get(typeId) ?? []),
      ];

      if (sellOrders.length === 0) {
        continue;
      }

      const pairs: Array<{
        buyOrder: GetMarketsRegionIdOrders200Ok;
        sellOrder: GetMarketsRegionIdOrders200Ok;
        units: number;
        spread: number;
        spreadValue: number;
      }> = [];

      for (const sellOrder of sellOrders) {
        for (const buyOrder of buyOrders) {
          const spread = buyOrder.price - sellOrder.price;

          if (spread <= 0) {
            continue;
          }

          const units = Math.min(sellOrder.volumeRemain, buyOrder.volumeRemain);

          if (units <= 0) {
            continue;
          }

          // A buy order's minVolume means the seller must deliver at least that many
          // units in a single transaction. Skip if we can't meet the requirement.
          if (buyOrder.minVolume !== undefined && units < buyOrder.minVolume) {
            continue;
          }

          const spreadValue = spread * units;

          pairs.push({
            buyOrder,
            sellOrder,
            units,
            spread,
            spreadValue,
          });
        }
      }

      if (pairs.length === 0) {
        continue;
      }

      pairs.sort((left, right) => right.spreadValue - left.spreadValue);

      const seenLocationPairs = new Set<string>();
      let accepted = 0;

      for (const pair of pairs) {
        const locationPairKey = `${pair.sellOrder.locationId}:${pair.buyOrder.locationId}`;

        if (seenLocationPairs.has(locationPairKey)) {
          continue;
        }

        seenLocationPairs.add(locationPairKey);

        spreadCandidates.push({
          typeId,
          buyOrder: pair.buyOrder,
          sellOrder: pair.sellOrder,
          units: pair.units,
          spread: pair.spread,
        });

        accepted += 1;

        if (accepted >= TOP_PAIRS_PER_TYPE) {
          break;
        }
      }
    }

    spreadCandidates.sort(
      (left, right) => right.spread * right.units - left.spread * left.units,
    );

    const topSpreadCandidates = spreadCandidates.slice(
      0,
      Math.max(120, filters.maxRoutesToEvaluate * 4),
    );
    const typeDetailsMap = await marketDataService.getTypeDetails(
      topSpreadCandidates.map((candidate) => candidate.typeId),
    );

    const candidates: CandidateOpportunity[] = [];
    let filteredByInvestment = 0;
    let filteredByCargo = 0;

    for (const candidate of topSpreadCandidates) {
      const typeDetails = typeDetailsMap.get(candidate.typeId);

      if (typeDetails === undefined) {
        continue;
      }

      const isSameSystem =
        candidate.buyOrder.systemId === candidate.sellOrder.systemId;

      // Cap units to what fits in cargo hold (for hauling trades).
      // Do not filter: show the deal for a reduced quantity rather than nothing.
      let units = candidate.units;
      if (!isSameSystem && typeDetails.volumeM3 > 0) {
        const maxUnitsByCargo = Math.floor(
          filters.maxCargoHold / typeDetails.volumeM3,
        );
        if (maxUnitsByCargo <= 0) {
          filteredByCargo++;
          continue;
        }
        units = Math.min(units, maxUnitsByCargo);
      }

      const investment = units * candidate.sellOrder.price;
      const cargoM3 = units * typeDetails.volumeM3;

      if (investment > filters.maxInvestment) {
        filteredByInvestment++;
        continue;
      }

      const grossProfit =
        units * (candidate.buyOrder.price - candidate.sellOrder.price);
      const salesTaxRate = this.getSalesTaxRate(filters.accountingLevel);
      // Use sell order profit formula for filtering (includes broker fee = most conservative).
      // No buy-side broker fee: we accept sell orders, not place buy orders.
      const sellRevenue =
        units *
        candidate.buyOrder.price *
        (1 - salesTaxRate - filters.brokerFeeRate);
      const buyingCost = units * candidate.sellOrder.price;
      const netProfit = sellRevenue - buyingCost;

      // Only add candidates with positive profit
      if (netProfit <= 0) {
        continue;
      }

      // Find cheapest existing sell order in the destination system for this type.
      // Will be resolved via targeted ESI call after candidates are built.
      const bestSellPriceAtBuyLocation = undefined;

      candidates.push({
        typeId: candidate.typeId,
        units,
        buyOrder: candidate.buyOrder,
        sellOrder: candidate.sellOrder,
        typeDetails,
        grossProfit,
        netProfit,
        investment,
        cargoM3,
        salesTaxRate,
        bestSellPriceAtBuyLocation,
      });
    }

    return candidates;
  }

  private async resolveBestSellPrices(
    candidates: CandidateOpportunity[],
  ): Promise<void> {
    // For each unique typeId+destinationRegion pair, fetch the cheapest sell order
    // directly from ESI using the type_id filter — avoids page-limit gaps in the bulk cache.
    const uniquePairs = [
      ...new Set(
        candidates.map((c) => {
          const regionId =
            HUB_SYSTEM_TO_REGION[c.buyOrder.systemId] ??
            this.getRegionForSystem(c.buyOrder.systemId);
          return `${c.buyOrder.systemId}:${regionId}:${c.typeId}`;
        }),
      ),
    ];

    const priceByKey = new Map<string, number | undefined>();
    let done = 0;
    await Promise.all(
      uniquePairs.map(async (key) => {
        const [systemIdStr, regionIdStr, typeIdStr] = key.split(":");
        const price = await marketDataService.getCheapestSellPrice(
          Number(systemIdStr),
          Number(regionIdStr),
          Number(typeIdStr),
        );
        priceByKey.set(key, price);
        done++;
        if (
          this.analyzeProgress.value?.step === "Fetching destination prices…"
        ) {
          this.analyzeProgress.value = {
            ...this.analyzeProgress.value,
            current: done,
          };
        }
      }),
    );

    for (const candidate of candidates) {
      const regionId =
        HUB_SYSTEM_TO_REGION[candidate.buyOrder.systemId] ??
        this.getRegionForSystem(candidate.buyOrder.systemId);
      candidate.bestSellPriceAtBuyLocation = priceByKey.get(
        `${candidate.buyOrder.systemId}:${regionId}:${candidate.typeId}`,
      );
    }
  }

  private getRegionForSystem(systemId: number): number {
    return HUB_SYSTEM_TO_REGION[systemId] ?? 10000002;
  }

  private getSalesTaxRate(accountingLevel: number): number {
    const level = Math.max(0, Math.min(5, accountingLevel));

    // EVE Online base sales tax is 7.5%; Accounting skill reduces it by 11% per level.
    return Math.max(0, 0.075 * (1 - 0.11 * level));
  }

  private toOpportunity(
    candidate: CandidateOpportunity,
    jumps: number,
    locationNames: Record<number, string>,
    buySystemName: string | undefined,
    sellSystemName: string | undefined,
    avgDailyTradeCount: number,
    avg90dPrice: number | undefined,
    brokerFeeRate: number,
  ): Omit<MarketOpportunity, "route"> {
    // Instant sell profit: sell immediately into the best buy order.
    // Sales tax applies to all sales (accepting a buy order is still a sale).
    const instantSellRevenue =
      candidate.units * candidate.buyOrder.price * (1 - candidate.salesTaxRate);
    const instantSellBuyCost = candidate.units * candidate.sellOrder.price;
    const instantSellProfit = instantSellRevenue - instantSellBuyCost;
    const instantSellProfitPerJump =
      jumps > 0 ? instantSellProfit / jumps : instantSellProfit;

    // Sell order profit: place a sell order — pays both sales tax and broker fee on revenue.
    const sellOrderProfit =
      candidate.bestSellPriceAtBuyLocation !== undefined
        ? candidate.units *
            candidate.bestSellPriceAtBuyLocation *
            (1 - candidate.salesTaxRate - brokerFeeRate) -
          candidate.units * candidate.sellOrder.price
        : undefined;
    const sellOrderProfitPerJump =
      sellOrderProfit !== undefined
        ? jumps > 0
          ? sellOrderProfit / jumps
          : sellOrderProfit
        : undefined;

    return {
      id: `${candidate.typeId}:${candidate.buyOrder.locationId}:${candidate.sellOrder.locationId}`,
      typeId: candidate.typeId,
      itemName: candidate.typeDetails.name,
      units: candidate.units,
      volumePerUnit: candidate.typeDetails.volumeM3,
      cargoM3: candidate.cargoM3,
      buyAtLocationId: candidate.sellOrder.locationId,
      buyAtLocationName:
        locationNames[candidate.sellOrder.locationId] ??
        `ID ${candidate.sellOrder.locationId}`,
      buyAtSystemId: candidate.sellOrder.systemId,
      buyAtSystemName:
        buySystemName ?? `System ${candidate.sellOrder.systemId}`,
      sellToLocationId: candidate.buyOrder.locationId,
      sellToLocationName:
        locationNames[candidate.buyOrder.locationId] ??
        `ID ${candidate.buyOrder.locationId}`,
      sellToSystemId: candidate.buyOrder.systemId,
      sellToSystemName:
        sellSystemName ?? `System ${candidate.buyOrder.systemId}`,
      buyPrice: candidate.sellOrder.price,
      sellPrice: candidate.buyOrder.price,
      bestSellPriceAtBuyLocation: candidate.bestSellPriceAtBuyLocation,
      grossProfit: candidate.grossProfit,
      salesTaxRate: candidate.salesTaxRate,
      netProfit: candidate.netProfit,
      instantSellProfit,
      instantSellProfitPerJump,
      sellOrderProfit,
      sellOrderProfitPerJump,
      investment: candidate.investment,
      jumps,
      profitPerJump: instantSellProfitPerJump,
      avgDailyTradeCount,
      avg90dPrice,
      instantSellVsAvg90d:
        avg90dPrice !== undefined && avg90dPrice > 0
          ? (candidate.buyOrder.price - avg90dPrice) / avg90dPrice
          : undefined,
      sellOrderVsAvg90d:
        avg90dPrice !== undefined &&
        avg90dPrice > 0 &&
        candidate.bestSellPriceAtBuyLocation !== undefined
          ? (candidate.bestSellPriceAtBuyLocation - avg90dPrice) / avg90dPrice
          : undefined,
    };
  }
}

export const arbitrageService = new ArbitrageService();
