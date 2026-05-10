import type { GetMarketsRegionIdOrders200Ok } from "@evespace/esi-client";

import type { TypeDetails } from "../types/domain";

export const MOCK_JITA_SYSTEM_ID = 30000142;
export const MOCK_AMARR_SYSTEM_ID = 30002187;
export const MOCK_JITA_STATION_ID = 60003760;
export const MOCK_AMARR_STATION_ID = 60008494;

export const MOCK_TYPE_DETAILS: TypeDetails[] = [
  { typeId: 34, name: "Tritanium", volumeM3: 0.01, canBeAssembled: false },
  { typeId: 35, name: "Pyerite", volumeM3: 0.01, canBeAssembled: false },
  { typeId: 36, name: "Mexallon", volumeM3: 0.01, canBeAssembled: false },
];

function order(input: {
  orderId: number;
  typeId: number;
  isBuyOrder: boolean;
  price: number;
  volumeRemain: number;
  locationId: number;
  systemId: number;
}): GetMarketsRegionIdOrders200Ok {
  return {
    orderId: input.orderId,
    typeId: input.typeId,
    isBuyOrder: input.isBuyOrder,
    price: input.price,
    volumeRemain: input.volumeRemain,
    volumeTotal: input.volumeRemain,
    minVolume: 1,
    issued: new Date().toISOString(),
    duration: 90,
    range: "station",
    locationId: input.locationId,
    systemId: input.systemId,
  } as unknown as GetMarketsRegionIdOrders200Ok;
}

export function getMockOrders(): GetMarketsRegionIdOrders200Ok[] {
  return [
    // Guaranteed profitable: buy in Jita at 4.10, sell to buy order in Amarr at 6.80
    order({
      orderId: 1,
      typeId: 34,
      isBuyOrder: false,
      price: 4.1,
      volumeRemain: 250000,
      locationId: MOCK_JITA_STATION_ID,
      systemId: MOCK_JITA_SYSTEM_ID,
    }),
    order({
      orderId: 2,
      typeId: 34,
      isBuyOrder: true,
      price: 6.8,
      volumeRemain: 180000,
      locationId: MOCK_AMARR_STATION_ID,
      systemId: MOCK_AMARR_SYSTEM_ID,
    }),

    // Second profitable deal
    order({
      orderId: 3,
      typeId: 35,
      isBuyOrder: false,
      price: 9.2,
      volumeRemain: 120000,
      locationId: MOCK_JITA_STATION_ID,
      systemId: MOCK_JITA_SYSTEM_ID,
    }),
    order({
      orderId: 4,
      typeId: 35,
      isBuyOrder: true,
      price: 12.6,
      volumeRemain: 90000,
      locationId: MOCK_AMARR_STATION_ID,
      systemId: MOCK_AMARR_SYSTEM_ID,
    }),

    // Noise (unprofitable) to verify filters are working
    order({
      orderId: 5,
      typeId: 36,
      isBuyOrder: false,
      price: 70,
      volumeRemain: 40000,
      locationId: MOCK_JITA_STATION_ID,
      systemId: MOCK_JITA_SYSTEM_ID,
    }),
    order({
      orderId: 6,
      typeId: 36,
      isBuyOrder: true,
      price: 68,
      volumeRemain: 40000,
      locationId: MOCK_AMARR_STATION_ID,
      systemId: MOCK_AMARR_SYSTEM_ID,
    }),
  ];
}

export function getMockLocationNames(): Record<number, string> {
  return {
    [MOCK_JITA_STATION_ID]: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    [MOCK_AMARR_STATION_ID]: "Amarr VIII (Oris) - Emperor Family Academy",
  };
}

export function isMockModeEnabled(): boolean {
  if (import.meta.env.VITE_USE_MOCK_DATA === "true") {
    return true;
  }

  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    return params.get("mockData") === "1";
  }

  return false;
}
