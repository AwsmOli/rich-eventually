export interface Region {
  id: number;
  name: string;
}

export const REGIONS: Region[] = [
  { id: 10000002, name: "The Forge" },
  { id: 10000043, name: "Domain" },
  { id: 10000030, name: "Sinq Laison" },
  { id: 10000032, name: "Placid" },
  { id: 10000042, name: "Metropolis" },
  { id: 10000048, name: "Essence" },
  { id: 10000064, name: "Heimatar" },
  { id: 10000065, name: "Khanid" },
  { id: 10000067, name: "Kador" },
  { id: 10000069, name: "Tash-Murkon" },
  { id: 10000062, name: "Molden Heath" },
  { id: 10000037, name: "Everyshore" },
  { id: 10000068, name: "Kor-Azor" },
  { id: 10000063, name: "Deklein" },
  { id: 10000066, name: "Kor-Azor Prime" },
];

export function getRegionName(regionId: number): string {
  const region = REGIONS.find((r) => r.id === regionId);
  return region?.name ?? `Region ${regionId}`;
}

export function getRegionId(regionName: string): number | undefined {
  const region = REGIONS.find((r) => r.name === regionName);
  return region?.id;
}
