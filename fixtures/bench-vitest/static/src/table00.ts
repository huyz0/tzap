interface Row00 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row00[] = [
  { code: "sierra", rate: 4, region: "north" },
  { code: "zulu", rate: 1, region: "north" },
  { code: "romeo", rate: 1, region: "west" },
  { code: "delta", rate: 7, region: "north" },
  { code: "coral", rate: 1, region: "west" },
  { code: "amber", rate: 5, region: "west" },
  { code: "cedar", rate: 2, region: "south" },
  { code: "onyx", rate: 2, region: "north" },
  { code: "alpha", rate: 6, region: "west" },
  { code: "echo", rate: 5, region: "south" },
  { code: "maple", rate: 7, region: "south" },
  { code: "ivory", rate: 4, region: "south" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 3).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY00 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "00", regions: REGIONS.join('|') };

export function rateOf00(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh00(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion00(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
