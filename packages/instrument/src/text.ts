import type { Position } from '@tzap/model';

/** Maps UTF-16 offsets to 1-based line and column. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(readonly source: string) {
    for (let i = 0; i < source.length; i++) {
      const ch = source.charCodeAt(i);
      if (ch === 10) this.starts.push(i + 1);
      else if (ch === 13) {
        if (source.charCodeAt(i + 1) === 10) i++;
        this.starts.push(i + 1);
      }
    }
  }

  position(offset: number): Position {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.starts[lo]! + 1 };
  }

  line(offset: number): number {
    return this.position(offset).line;
  }

  /** The offset of a 1-based line and column: the inverse of `position`. */
  offset(line: number, column: number): number {
    return (this.starts[line - 1] ?? this.source.length) + column - 1;
  }

  get lineCount(): number {
    return this.starts.length;
  }
}

/**
 * Finds `token` in `source` between `from` and `to`, skipping comments. Used to locate an
 * operator between the end of its left operand and the start of its right one, where only
 * whitespace, parentheses and comments can otherwise appear.
 */
export function findToken(source: string, token: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? to : nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? to : close + 2;
      continue;
    }
    if (source.startsWith(token, i)) return i;
    i++;
  }
  return -1;
}

/** Offset of the first non-whitespace, non-comment character at or after `from`. */
export function skipTrivia(source: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (source[i] === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl === -1) return source.length;
      i = nl + 1;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) return source.length;
      i = close + 2;
      continue;
    }
    return i;
  }
}

/** Source text as mutants report it: at most 200 characters, a longer one cut to 197 and `...`. */
export function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}
