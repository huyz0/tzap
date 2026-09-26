interface Row02 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row02[] = [
  { code: "delta", rate: 7, region: "south" },
  { code: "zulu", rate: 1, region: "east" },
  { code: "victor", rate: 2, region: "east" },
  { code: "amber", rate: 9, region: "north" },
  { code: "mango", rate: 1, region: "west" },
  { code: "maple", rate: 4, region: "west" },
  { code: "coral", rate: 7, region: "north" },
  { code: "lima", rate: 2, region: "east" },
  { code: "oscar", rate: 3, region: "south" },
  { code: "papa", rate: 2, region: "north" },
  { code: "sierra", rate: 6, region: "north" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 3).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY02 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "02", regions: REGIONS.join('|') };

export function rateOf02(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh02(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion02(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
