interface Row14 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row14[] = [
  { code: "maple", rate: 4, region: "west" },
  { code: "coral", rate: 7, region: "west" },
  { code: "cedar", rate: 9, region: "south" },
  { code: "papa", rate: 7, region: "south" },
  { code: "mango", rate: 1, region: "north" },
  { code: "ivory", rate: 6, region: "north" },
  { code: "onyx", rate: 3, region: "north" },
  { code: "oscar", rate: 6, region: "north" },
  { code: "bravo", rate: 8, region: "north" },
  { code: "lima", rate: 9, region: "west" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 6).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY14 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "14", regions: REGIONS.join('|') };

export function rateOf14(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh14(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion14(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
