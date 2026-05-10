import { ref } from "vue";

import type {
  StationTradeFilters,
  StationTradeOpportunity,
} from "../types/domain";
import { marketDataService } from "./marketDataService";

// The 5 major trade hubs: systemId → regionId
export const TRADE_HUBS: Array<{
  systemId: number;
  regionId: number;
  name: string;
}> = [
  { systemId: 30000142, regionId: 10000002, name: "Jita (The Forge)" },
  { systemId: 30002187, regionId: 10000043, name: "Amarr (Domain)" },
  { systemId: 30002659, regionId: 10000032, name: "Dodixie (Sinq Laison)" },
  { systemId: 30002510, regionId: 10000042, name: "Hek (Metropolis)" },
  { systemId: 30004588, regionId: 10000030, name: "Rens (Heimatar)" },
];

export interface StationTradeProgress {
  step: string;
  current: number;
  total: number;
}

class StationTradeService {
  public readonly progress = ref<StationTradeProgress | undefined>(undefined);

  public async findOpportunities(
    filters: StationTradeFilters,
  ): Promise<StationTradeOpportunity[]> {
    const hub = TRADE_HUBS.find((h) => h.systemId === filters.hubSystemId);
    if (hub === undefined) throw new Error("Unknown trade hub system ID.");

    const salesTaxRate = Math.max(
      0,
      0.075 * (1 - 0.11 * Math.max(0, Math.min(5, filters.accountingLevel))),
    );
    const brokerFeeRate = Math.min(0.1, (filters.brokerFeePercent ?? 3) / 100);

    // Use the cached regional orders (populated by background scanner).
    this.progress.value = {
      step: "Reading cached orders…",
      current: 0,
      total: 1,
    };
    const regionOrders = marketDataService.getRegionOrders(hub.regionId);

    // Filter to this system only, then split into buy / sell sides.
    const buyByType = new Map<number, number>(); // typeId → highest buy price
    const sellByType = new Map<number, number>(); // typeId → cheapest sell price

    for (const order of regionOrders) {
      if (order.systemId !== hub.systemId) continue;
      if (order.isBuyOrder) {
        const cur = buyByType.get(order.typeId);
        if (cur === undefined || order.price > cur)
          buyByType.set(order.typeId, order.price);
      } else {
        const cur = sellByType.get(order.typeId);
        if (cur === undefined || order.price < cur)
          sellByType.set(order.typeId, order.price);
      }
    }

    // Keep only types that have both sides and a positive after-fee margin.
    const candidateTypeIds: number[] = [];
    for (const [typeId, cheapestSell] of sellByType) {
      const highestBuy = buyByType.get(typeId);
      if (highestBuy === undefined) continue;
      if (cheapestSell <= highestBuy) continue; // no spread (market crossed)
      const buyCost = highestBuy * (1 + salesTaxRate + brokerFeeRate);
      const sellRevenue = cheapestSell * (1 - salesTaxRate - brokerFeeRate);
      const margin = ((sellRevenue - buyCost) / buyCost) * 100;
      if (margin < filters.minMarginPercent) continue;
      candidateTypeIds.push(typeId);
    }

    if (candidateTypeIds.length === 0) return [];

    // History phase: synchronously resolve cache hits, async-fetch only misses.
    const avgTradesByType = new Map<number, number>();
    const avg90dPriceByType = new Map<number, number | undefined>();
    const missIds: number[] = [];

    for (const typeId of candidateTypeIds) {
      const cached = marketDataService.getHistorySummarySync(
        hub.regionId,
        typeId,
      );
      if (cached !== undefined) {
        avgTradesByType.set(typeId, cached.avgOrderCount);
        avg90dPriceByType.set(typeId, cached.avgPrice);
      } else {
        missIds.push(typeId);
      }
    }

    if (missIds.length > 0) {
      this.progress.value = {
        step: "Fetching trade history…",
        current: 0,
        total: missIds.length,
      };
      await Promise.all(
        missIds.map(async (typeId) => {
          try {
            const { avgOrderCount, avgPrice } =
              await marketDataService.getHistorySummary(hub.regionId, typeId);
            avgTradesByType.set(typeId, avgOrderCount);
            avg90dPriceByType.set(typeId, avgPrice);
          } catch {
            avgTradesByType.set(typeId, 0);
            avg90dPriceByType.set(typeId, undefined);
          }
          this.progress.value = {
            step: "Fetching trade history…",
            current: (this.progress.value?.current ?? 0) + 1,
            total: missIds.length,
          };
        }),
      );
    }

    // Apply min avg daily trades filter.
    const filteredTypeIds = candidateTypeIds.filter(
      (id) => (avgTradesByType.get(id) ?? 0) >= filters.minAvgDailyTrades,
    );

    if (filteredTypeIds.length === 0) return [];

    // Resolve item names (cached in localStorage — free on subsequent runs).
    this.progress.value = {
      step: "Resolving item names…",
      current: 0,
      total: filteredTypeIds.length,
    };
    const typeDetailsMap = await marketDataService.getTypeDetails(
      filteredTypeIds,
      (done, total) => {
        this.progress.value = {
          step: "Resolving item names…",
          current: done,
          total,
        };
      },
    );

    // Build result objects.
    const results: StationTradeOpportunity[] = [];

    for (const typeId of filteredTypeIds) {
      const cheapestSell = sellByType.get(typeId)!;
      const highestBuy = buyByType.get(typeId)!;
      const typeDetails = typeDetailsMap.get(typeId);
      if (typeDetails === undefined) continue;

      // Station trading profit model (per unit):
      //   Buy side:  place a buy order above highestBuyPrice → pay broker fee + sales tax when filled
      //   Sell side: place a sell order below cheapestSellPrice → pay broker fee + sales tax when filled
      //   profitPerUnit = cheapestSell × (1 - salesTax - brokerFee) - highestBuy × (1 + salesTax + brokerFee)
      const buyCost = highestBuy * (1 + salesTaxRate + brokerFeeRate);
      const sellRevenue = cheapestSell * (1 - salesTaxRate - brokerFeeRate);
      const profitPerUnit = sellRevenue - buyCost;
      const marginPercent = (profitPerUnit / buyCost) * 100;

      const avgDailyTrades = avgTradesByType.get(typeId) ?? 0;
      const avg90dPrice = avg90dPriceByType.get(typeId);
      // Use midpoint of spread as a proxy for the "current price" vs 90d avg.
      const midpoint = (highestBuy + cheapestSell) / 2;
      const vsAvg90d =
        avg90dPrice !== undefined && avg90dPrice > 0
          ? (midpoint - avg90dPrice) / avg90dPrice
          : undefined;

      results.push({
        typeId,
        itemName: typeDetails.name,
        highestBuyPrice: highestBuy,
        cheapestSellPrice: cheapestSell,
        marginPercent,
        profitPerUnit,
        avgDailyTrades,
        tradeVolumeIsk: avgDailyTrades * highestBuy,
        avg90dPrice,
        vsAvg90d,
      });
    }

    // Apply item value filters (cheapestSellPrice used as the item's ISK value).
    const minVal = filters.minItemValue ?? 0;
    const maxVal = filters.maxItemValue ?? 0;
    const filtered = results.filter((r) => {
      if (minVal > 0 && r.cheapestSellPrice < minVal) return false;
      if (maxVal > 0 && r.cheapestSellPrice > maxVal) return false;
      return true;
    });

    // Sort by ISK volume (high-traffic, high-margin items first).
    filtered.sort((a, b) => b.tradeVolumeIsk - a.tradeVolumeIsk);

    this.progress.value = undefined;
    return filtered;
  }
}

export const stationTradeService = new StationTradeService();
