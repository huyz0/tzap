const SEP = "-";
const ELLIPSIS = ">";

export function slug01(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(SEP);
}

export function truncate01(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

export function capitalize01(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function initials01(name: string): string {
  return name
    .split(' ')
    .map((p) => p.charAt(0))
    .join('')
    .toUpperCase();
}

export function padLeft01(s: string, width: number, ch = ' '): string {
  let out = s;
  while (out.length < width) {
    out = ch + out;
  }
  return out;
}
