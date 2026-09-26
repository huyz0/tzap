interface Row06 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row06[] = [
  { code: "delta", rate: 3, region: "west" },
  { code: "oscar", rate: 8, region: "west" },
  { code: "sierra", rate: 4, region: "east" },
  { code: "zulu", rate: 8, region: "east" },
  { code: "tango", rate: 8, region: "west" },
  { code: "maple", rate: 7, region: "north" },
  { code: "mango", rate: 3, region: "west" },
  { code: "lima", rate: 9, region: "east" },
  { code: "ivory", rate: 6, region: "east" },
  { code: "bravo", rate: 7, region: "west" },
  { code: "romeo", rate: 3, region: "east" },
  { code: "cedar", rate: 4, region: "east" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 6).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY06 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "06", regions: REGIONS.join('|') };

export function rateOf06(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh06(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion06(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
