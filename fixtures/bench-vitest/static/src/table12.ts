interface Row12 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row12[] = [
  { code: "coral", rate: 9, region: "south" },
  { code: "echo", rate: 6, region: "west" },
  { code: "zulu", rate: 1, region: "west" },
  { code: "tango", rate: 3, region: "south" },
  { code: "victor", rate: 3, region: "north" },
  { code: "amber", rate: 4, region: "north" },
  { code: "onyx", rate: 1, region: "east" },
  { code: "mango", rate: 5, region: "south" },
  { code: "ivory", rate: 9, region: "south" },
  { code: "bravo", rate: 5, region: "north" },
  { code: "maple", rate: 4, region: "west" },
  { code: "cedar", rate: 6, region: "east" },
  { code: "kilo", rate: 1, region: "south" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 5).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY12 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "12", regions: REGIONS.join('|') };

export function rateOf12(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh12(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion12(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
