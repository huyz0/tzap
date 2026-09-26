interface Row04 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row04[] = [
  { code: "amber", rate: 7, region: "south" },
  { code: "kilo", rate: 3, region: "east" },
  { code: "zulu", rate: 2, region: "north" },
  { code: "echo", rate: 3, region: "east" },
  { code: "victor", rate: 2, region: "east" },
  { code: "bravo", rate: 7, region: "north" },
  { code: "papa", rate: 7, region: "east" },
  { code: "oscar", rate: 9, region: "north" },
  { code: "ivory", rate: 9, region: "west" },
  { code: "maple", rate: 1, region: "south" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 5).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY04 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "04", regions: REGIONS.join('|') };

export function rateOf04(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh04(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion04(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
