interface Row01 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row01[] = [
  { code: "alpha", rate: 8, region: "north" },
  { code: "amber", rate: 3, region: "south" },
  { code: "lima", rate: 8, region: "east" },
  { code: "echo", rate: 4, region: "north" },
  { code: "oscar", rate: 7, region: "south" },
  { code: "maple", rate: 3, region: "west" },
  { code: "romeo", rate: 2, region: "east" },
  { code: "onyx", rate: 5, region: "east" },
  { code: "kilo", rate: 1, region: "east" },
  { code: "delta", rate: 7, region: "south" },
  { code: "ivory", rate: 3, region: "east" },
  { code: "bravo", rate: 1, region: "west" },
  { code: "tango", rate: 7, region: "east" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 6).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY01 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "01", regions: REGIONS.join('|') };

export function rateOf01(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh01(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion01(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
