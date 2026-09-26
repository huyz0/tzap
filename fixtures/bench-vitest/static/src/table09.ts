interface Row09 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row09[] = [
  { code: "mango", rate: 5, region: "west" },
  { code: "cedar", rate: 3, region: "west" },
  { code: "sierra", rate: 7, region: "west" },
  { code: "victor", rate: 6, region: "east" },
  { code: "maple", rate: 6, region: "north" },
  { code: "papa", rate: 5, region: "north" },
  { code: "coral", rate: 4, region: "east" },
  { code: "onyx", rate: 5, region: "east" },
  { code: "bravo", rate: 5, region: "west" },
  { code: "kilo", rate: 4, region: "west" },
  { code: "ivory", rate: 1, region: "east" },
  { code: "alpha", rate: 6, region: "south" },
  { code: "delta", rate: 4, region: "west" },
  { code: "oscar", rate: 2, region: "west" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 6).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY09 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "09", regions: REGIONS.join('|') };

export function rateOf09(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh09(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion09(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
