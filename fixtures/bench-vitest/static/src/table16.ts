interface Row16 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row16[] = [
  { code: "oscar", rate: 5, region: "north" },
  { code: "victor", rate: 4, region: "north" },
  { code: "onyx", rate: 8, region: "south" },
  { code: "delta", rate: 1, region: "west" },
  { code: "mango", rate: 9, region: "south" },
  { code: "lima", rate: 6, region: "east" },
  { code: "cedar", rate: 5, region: "west" },
  { code: "sierra", rate: 9, region: "west" },
  { code: "tango", rate: 2, region: "south" },
  { code: "papa", rate: 3, region: "south" },
  { code: "bravo", rate: 7, region: "west" },
  { code: "echo", rate: 3, region: "south" },
  { code: "amber", rate: 2, region: "east" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 4).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY16 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "16", regions: REGIONS.join('|') };

export function rateOf16(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh16(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion16(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
