interface Row10 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row10[] = [
  { code: "victor", rate: 7, region: "north" },
  { code: "echo", rate: 5, region: "north" },
  { code: "oscar", rate: 5, region: "west" },
  { code: "ivory", rate: 5, region: "west" },
  { code: "maple", rate: 1, region: "north" },
  { code: "delta", rate: 3, region: "north" },
  { code: "onyx", rate: 8, region: "east" },
  { code: "cedar", rate: 9, region: "north" },
  { code: "sierra", rate: 3, region: "east" },
  { code: "romeo", rate: 3, region: "west" },
  { code: "alpha", rate: 4, region: "east" },
  { code: "papa", rate: 4, region: "east" },
  { code: "mango", rate: 6, region: "south" },
  { code: "coral", rate: 5, region: "south" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 6).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY10 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "10", regions: REGIONS.join('|') };

export function rateOf10(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh10(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion10(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
