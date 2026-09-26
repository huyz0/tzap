interface Row18 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row18[] = [
  { code: "cedar", rate: 5, region: "east" },
  { code: "maple", rate: 6, region: "south" },
  { code: "romeo", rate: 3, region: "west" },
  { code: "alpha", rate: 7, region: "east" },
  { code: "lima", rate: 5, region: "west" },
  { code: "coral", rate: 4, region: "south" },
  { code: "mango", rate: 6, region: "east" },
  { code: "onyx", rate: 4, region: "north" },
  { code: "sierra", rate: 4, region: "south" },
  { code: "oscar", rate: 4, region: "west" },
  { code: "bravo", rate: 6, region: "south" },
  { code: "tango", rate: 9, region: "north" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 4).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY18 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "18", regions: REGIONS.join('|') };

export function rateOf18(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh18(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion18(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
