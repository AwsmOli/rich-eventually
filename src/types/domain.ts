export type RouteSecurityPreference = "shortest" | "secure" | "insecure";

export interface ArbitrageFilters {
  regionId: number;
  scanAllRegions: boolean;
  fromSystemName: string;
  toSystemName: string;
  avoidSystemsInput: string;
  maxCargoHold: number;
  maxInvestment: number;
  maxJumps: number;
  routeSecurity: RouteSecurityPreference;
  accountingLevel: number;
  brokerFeePercent: number;
  maxRoutesToEvaluate: number;
  minAvgDailyTradeCount: number;
}

export interface ResolvedFilters {
  regionId: number;
  fromSystemId?: number;
  toSystemId?: number;
  avoidSystemIds: number[];
  maxCargoHold: number;
  maxInvestment: number;
  maxJumps: number;
  routeSecurity: RouteSecurityPreference;
  accountingLevel: number;
  brokerFeeRate: number;
  maxRoutesToEvaluate: number;
  minAvgDailyIskVolume: number;
}

export interface TypeDetails {
  typeId: number;
  name: string;
  volumeM3: number;
  /** True if ESI reports a distinct packagedVolume (e.g. ships that can be assembled). */
  canBeAssembled: boolean;
}

export interface RouteSecuritySquare {
  systemId: number;
  systemName: string;
  securityStatus: number;
  color: string;
}

export interface RouteDetails {
  systems: number[];
  jumps: number;
  squares: RouteSecuritySquare[];
  originName: string;
  destinationName: string;
}

export interface MarketOpportunity {
  id: string;
  typeId: number;
  itemName: string;
  units: number;
  volumePerUnit: number;
  cargoM3: number;
  buyAtLocationId: number;
  buyAtLocationName: string;
  buyAtSystemId: number;
  buyAtSystemName: string;
  sellToLocationId: number;
  sellToLocationName: string;
  sellToSystemId: number;
  sellToSystemName: string;
  buyPrice: number;
  sellPrice: number;
  bestSellPriceAtBuyLocation: number | undefined;
  grossProfit: number;
  salesTaxRate: number;
  netProfit: number;
  instantSellProfit: number;
  instantSellProfitPerJump: number;
  sellOrderProfit: number | undefined;
  sellOrderProfitPerJump: number | undefined;
  investment: number;
  jumps: number;
  profitPerJump: number;
  avgDailyTradeCount: number;
  avg90dPrice: number | undefined;
  instantSellVsAvg90d: number | undefined;
  sellOrderVsAvg90d: number | undefined;
  route: RouteDetails;
}

export interface ArbitrageQueryResult {
  opportunities: MarketOpportunity[];
  warnings: string[];
  fetchedAt: number;
}

// ─── Station Trading ─────────────────────────────────────────────────────────

export interface StationTradeFilters {
  hubSystemId: number;
  minMarginPercent: number;
  /** Minimum after-fee profit per unit (ISK). 0 = no limit. */
  minProfitPerUnit: number;
  brokerFeePercent: number;
  accountingLevel: number;
  minAvgDailyTrades: number;
  /** Minimum sell price (ISK); items cheaper than this are excluded. 0 = no limit. */
  minItemValue: number;
  /** Maximum sell price (ISK); items more expensive than this are excluded. 0 = no limit. */
  maxItemValue: number;
}

export interface StationTradeOpportunity {
  typeId: number;
  itemName: string;
  highestBuyPrice: number; // best buy order in the station — what you'll receive
  cheapestSellPrice: number; // cheapest sell order in the station — what you pay
  marginPercent: number; // after-fee profit / buy cost
  profitPerUnit: number; // after sales tax + broker fee on both sides
  avgDailyTrades: number; // 90-day average daily order count (region-level)
  tradeVolumeIsk: number; // avgDailyTrades × highestBuyPrice (rough ISK volume)
  avg90dPrice: number | undefined; // 90-day average transaction price
  vsAvg90d: number | undefined; // (midpoint - avg90dPrice) / avg90dPrice as fraction
  /** True if the character currently has this item in their inventory. */
  hasInventory: boolean;
}
