interface Row05 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row05[] = [
  { code: "coral", rate: 2, region: "west" },
  { code: "echo", rate: 5, region: "north" },
  { code: "bravo", rate: 7, region: "north" },
  { code: "delta", rate: 2, region: "south" },
  { code: "kilo", rate: 1, region: "north" },
  { code: "cedar", rate: 1, region: "north" },
  { code: "zulu", rate: 9, region: "east" },
  { code: "victor", rate: 9, region: "west" },
  { code: "oscar", rate: 4, region: "west" },
  { code: "sierra", rate: 2, region: "east" },
  { code: "amber", rate: 3, region: "east" },
  { code: "maple", rate: 3, region: "east" },
  { code: "onyx", rate: 8, region: "west" },
  { code: "papa", rate: 4, region: "south" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 6).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY05 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "05", regions: REGIONS.join('|') };

export function rateOf05(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh05(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion05(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
