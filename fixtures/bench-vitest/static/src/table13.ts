interface Row13 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row13[] = [
  { code: "bravo", rate: 4, region: "east" },
  { code: "coral", rate: 9, region: "north" },
  { code: "oscar", rate: 4, region: "south" },
  { code: "zulu", rate: 9, region: "west" },
  { code: "ivory", rate: 6, region: "west" },
  { code: "onyx", rate: 6, region: "west" },
  { code: "lima", rate: 3, region: "west" },
  { code: "amber", rate: 3, region: "east" },
  { code: "maple", rate: 3, region: "south" },
  { code: "delta", rate: 4, region: "west" },
  { code: "mango", rate: 9, region: "north" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 4).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY13 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "13", regions: REGIONS.join('|') };

export function rateOf13(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh13(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion13(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
