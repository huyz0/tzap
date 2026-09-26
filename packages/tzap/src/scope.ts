/**
 * Widening a diff scope: from the changed lines to the functions that hold them, or to the whole
 * of each changed file. A change inside a function can break any of it, and a reviewer often
 * wants every mutant of the function they touched, not only those on the lines they edited.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LineIndex, parse, type LineRange, type Node } from '@tzap/instrument';
import type { Granularity } from '@tzap/model';

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Line spans of every function in a file, from its parse; undefined when it cannot be parsed. */
function functionSpans(file: string, source: string, lines: LineIndex): LineRange[] | undefined {
  if (/\.(vue|svelte)$/i.test(file)) return undefined;
  const parsed = parse(file, source);
  if (parsed.errors.length > 0 || !parsed.program) return undefined;
  const spans: LineRange[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (typeof n !== 'object' || n === null) return;
    const node = n as Node;
    if (FUNCTIONS.has(node.type)) spans.push([lines.line(node.start), lines.line(Math.max(node.start, node.end - 1))]);
    for (const [k, v] of Object.entries(node)) if (k !== 'parent' && typeof v === 'object') visit(v);
  };
  visit(parsed.program);
  return spans;
}

/** Sorted, with overlapping and adjacent ranges merged. */
function merge(ranges: LineRange[]): LineRange[] {
  const out: Array<[number, number]> = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The changed lines of each file (root-relative path -> ranges), widened to `granularity`.
 * `function`: each changed line grows to the innermost function containing it; lines outside
 * any function stay as they are. `file`: every changed file is in scope whole. A file that is
 * gone or cannot be parsed keeps its changed lines: widening never loses a changed line.
 */
export function widenScope(root: string, files: ReadonlyMap<string, readonly LineRange[]>, granularity: Granularity): Map<string, LineRange[]> {
  const out = new Map<string, LineRange[]>();
  for (const [file, ranges] of files) {
    if (granularity === 'line') {
      out.set(file, [...ranges]);
      continue;
    }
    let source: string;
    try {
      source = readFileSync(path.join(root, file), 'utf8');
    } catch {
      out.set(file, [...ranges]);
      continue;
    }
    const lines = new LineIndex(source);
    if (granularity === 'file') {
      out.set(file, [[1, lines.lineCount]]);
      continue;
    }
    const spans = functionSpans(file, source, lines);
    if (!spans) {
      out.set(file, [...ranges]);
      continue;
    }
    const widened: LineRange[] = [...ranges];
    for (const [a, b] of ranges) {
      for (let line = a; line <= b; line++) {
        let inner: LineRange | undefined;
        for (const s of spans) if (s[0] <= line && line <= s[1] && (!inner || s[1] - s[0] < inner[1] - inner[0])) inner = s;
        if (inner) widened.push(inner);
      }
    }
    out.set(file, merge(widened));
  }
  return out;
}
