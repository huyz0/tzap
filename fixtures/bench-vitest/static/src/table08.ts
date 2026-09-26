interface Row08 {
  code: string;
  rate: number;
  region: string;
}

const TABLE: Row08[] = [
  { code: "amber", rate: 1, region: "east" },
  { code: "delta", rate: 9, region: "north" },
  { code: "kilo", rate: 5, region: "west" },
  { code: "zulu", rate: 8, region: "north" },
  { code: "onyx", rate: 4, region: "west" },
  { code: "coral", rate: 1, region: "north" },
  { code: "sierra", rate: 2, region: "east" },
  { code: "papa", rate: 9, region: "east" },
  { code: "mango", rate: 2, region: "south" },
  { code: "tango", rate: 9, region: "east" },
  { code: "victor", rate: 7, region: "east" },
  { code: "cedar", rate: 9, region: "south" },
  { code: "lima", rate: 3, region: "south" },
];

const BY_CODE = new Map(TABLE.map((r) => [r.code, r]));
const HIGH = TABLE.filter((r) => r.rate > 3).map((r) => r.code.toUpperCase() + '!');
const REGIONS = [...new Set(TABLE.map((r) => r.region))].sort();
export const SUMMARY08 = { rows: TABLE.length, high: HIGH.length, name: 'table-' + "08", regions: REGIONS.join('|') };

export function rateOf08(code: string): number {
  return BY_CODE.get(code)?.rate ?? -1;
}

export function isHigh08(code: string): boolean {
  return HIGH.includes(code.toUpperCase() + '!');
}

export function inRegion08(region: string): string[] {
  return TABLE.filter((r) => r.region === region).map((r) => r.code);
}
