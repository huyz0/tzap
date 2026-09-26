interface Row17 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row17[] = [
  { code: "delta", rate: 4, region: "south" },
  { code: "maple", rate: 3, region: "north" },
  { code: "sierra", rate: 7, region: "east" },
  { code: "amber", rate: 3, region: "east" },
  { code: "ivory", rate: 5, region: "west" },
  { code: "coral", rate: 1, region: "north" },
  { code: "bravo", rate: 6, region: "north" },
  { code: "alpha", rate: 4, region: "east" },
  { code: "zulu", rate: 9, region: "west" },
  { code: "mango", rate: 4, region: "east" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 4).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY17 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "17", regions: REGIONS.join('|') };

export function rateOf17(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh17(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion17(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
