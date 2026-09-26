import { compareMutants, type AnalysisResult, type MutantResult, type MutantStatus } from '@tzap/model';

/** What every reporter is given besides the result. `writeReports` is the only part that does I/O. */
export interface ReportContext {
  outDir: string;
  /** ANSI colour in terminal output. */
  color: boolean;
  /** Minimum passing mutation score, as a percentage. Reporters only display it. */
  threshold?: number;
}

/** Mutants in report order, independent of the order the engine happened to produce them in. */
export function sorted(mutants: readonly MutantResult[], status?: MutantStatus): MutantResult[] {
  return mutants.filter((m) => status === undefined || m.status === status).sort(compareMutants);
}

/** Groups already-sorted mutants by file, keeping their order. */
export function byFile(mutants: readonly MutantResult[]): Map<string, MutantResult[]> {
  const out = new Map<string, MutantResult[]>();
  for (const m of mutants) {
    const list = out.get(m.file);
    if (list) list.push(m);
    else out.set(m.file, [m]);
  }
  return out;
}

/** One decimal, `n/a` for the NaN that `score()` returns when nothing is valid. */
export function pct(n: number): string {
  return Number.isNaN(n) ? 'n/a' : `${n.toFixed(1)}%`;
}

function clip(s: string, max = 40): string {
  const one = s.replace(/\s*\r?\n\s*/g, ' ');
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

/** The mutant's description, or one made from its text when the mutator gave none. Always one line. */
export function describe(m: MutantResult): string {
  return m.description !== undefined
    ? m.description.replace(/\s*\r?\n\s*/g, ' ')
    : `replaced ${clip(m.original)} with ${clip(m.replacement)}`;
}

/** Source lines per file, split once. */
export function sourceLines(result: AnalysisResult): (file: string, line: number) => string | undefined {
  const cache = new Map<string, string[]>();
  return (file, line) => {
    let lines = cache.get(file);
    if (!lines) {
      lines = result.files[file]?.source.split(/\r?\n/) ?? [];
      cache.set(file, lines);
    }
    return lines[line - 1];
  };
}

/** Plain-object keys in code-unit order, so no locale can change the output. */
export function sortedKeys(o: object): string[] {
  return Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A copy of `o` with `first` in that order, then any other keys sorted; undefined values dropped. */
export function ordered<T extends object>(o: T, first: readonly string[]): T {
  const src = o as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of [...first, ...sortedKeys(o).filter((k) => !first.includes(k))]) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out as T;
}

export function byString<T>(key: (t: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

/** Tests in report order: by file, then name, then id. */
export const byTest = byString<{ file: string; name: string; id: string }>((t) => `${t.file}\0${t.name}\0${t.id}`);
