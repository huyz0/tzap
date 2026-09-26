/**
 * The instrumented modules of a session, served in place of the originals through Node's module
 * hooks, and the import edges seen while they load: what a test file reaches outside any test.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normPath } from '@tzap/protocol';
import { realPath, urlToNorm } from './util.js';

type LoadResult = { format?: string; source?: unknown; shortCircuit?: boolean };

export class InstrumentedModules {
  /** Instrumented source by normalised path, as given and as resolved. */
  private readonly code = new Map<string, string>();
  /** Instrumentation sites by module (normalised path). */
  private readonly sitesOf = new Map<string, number[]>();
  /** Import edges seen by the resolve hook, normalised paths. */
  private readonly edges = new Map<string, Set<string>>();

  /** Reads the session's instrumented-sources file (absolute path -> { code }). */
  constructor(file: string) {
    const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { code: string }>;
    for (const [f, v] of Object.entries(map)) {
      const sites = [...new Set([...v.code.matchAll(/__tzap\.c\[(\d+)\]/g)].map((m) => Number(m[1])))];
      for (const key of new Set([normPath(path.resolve(f)), normPath(realPath(path.resolve(f)))])) {
        this.code.set(key, v.code);
        this.sitesOf.set(key, sites);
      }
    }
  }

  /** Records that `parentUrl` imports `childUrl`, both `file:` URLs. */
  recordEdge(parentUrl: string | undefined, childUrl: string): void {
    if (!parentUrl?.startsWith('file:') || !childUrl.startsWith('file:')) return;
    const p = urlToNorm(parentUrl);
    const c = urlToNorm(childUrl);
    if (!p || !c) return;
    let set = this.edges.get(p);
    if (!set) this.edges.set(p, (set = new Set()));
    set.add(c);
  }

  /** A `module.registerHooks` load hook: the instrumented source for an instrumented module. */
  readonly load = (url: string, context: object, next: (u: string, c: object) => LoadResult): LoadResult => {
    const r = next(url, context);
    if (!url.startsWith('file:')) return r;
    const key = urlToNorm(url);
    const code = key === undefined ? undefined : this.code.get(key);
    if (code === undefined) return r;
    // For .ts files the format is module-typescript / commonjs-typescript and Node strips the
    // (still TypeScript) instrumented source exactly as it would have stripped the original.
    return { ...r, format: r.format ?? 'module', source: code, shortCircuit: true };
  };

  /**
   * Hits outside any test (module evaluation, suite hooks) attributed to a test file. A module
   * evaluates once, while the first file that imports it loads, so the hits are attributed to
   * every test file whose import closure reaches the module: each of them would evaluate it in a
   * fresh process.
   */
  staticHitsFor(file: string, outside: ReadonlyMap<number, number>): Array<[number, number]> {
    if (outside.size === 0) return [];
    const seen = new Set<string>();
    const stack = [normPath(realPath(file)), normPath(file)];
    while (stack.length) {
      const m = stack.pop()!;
      if (seen.has(m)) continue;
      seen.add(m);
      for (const c of this.edges.get(m) ?? []) stack.push(c);
    }
    const out: Array<[number, number]> = [];
    const counted = new Set<number>();
    for (const m of seen) {
      for (const site of this.sitesOf.get(m) ?? []) {
        const n = outside.get(site);
        if (n !== undefined && !counted.has(site)) {
          counted.add(site);
          out.push([site, n]);
        }
      }
    }
    return out.sort((a, b) => a[0] - b[0]);
  }
}
