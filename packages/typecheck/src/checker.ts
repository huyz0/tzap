/**
 * Type-checks mutants against the project's own tsconfig.
 *
 * A mutant is rejected when a checked file has an error diagnostic after the mutant is spliced
 * into the original source that it did not have before: errors present in the unmutated
 * project are baseline noise, matched by code and message at the position shifted by the edit.
 * The checked files are the mutated file and, by default, the project files that import it
 * directly (a mutant that changes an exported, inferred type can break its importers).
 *
 * Grouping, after Stryker's checker: mutants in different files, or in different units of the
 * same file (top-level statements; members of a top-level class), are spliced in together and
 * checked in one pass. No new diagnostic: every mutant in the group is viable. A new diagnostic
 * inside exactly one mutant's replacement, or in a file that only one mutant of the group can
 * have affected, is attributed to that mutant; any other new diagnostic makes its candidate
 * mutants ambiguous, and they are re-checked one at a time.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MutantDescriptor } from '@tzap/model';
import { parse, type Node } from '@tzap/instrument';
import { type Backend, type Diag, fileKey, loadBackend, slash, type TypeScriptChoice } from './backend.js';

export interface TypeCheckerOptions {
  root: string;
  /** One tsconfig for every file. Default: the nearest `tsconfig.json` above each mutated file (up to `root`). */
  tsconfig?: string;
  /** Which compiler API to use. `auto`: TypeScript 7's unstable API if the project has typescript >= 7, else the classic API. */
  typescript?: TypeScriptChoice;
  /** Directories to resolve `typescript` from, in order. Default: the tsconfig's directory, then `root`. */
  resolveFrom?: readonly string[];
  /** Check mutants in groups (default true). */
  grouping?: boolean;
  /** Most mutants per group (default 200). */
  maxGroup?: number;
  /** Also check the project files that import a mutated file (default true). */
  dependents?: boolean;
}

export interface TypeCheckStats {
  backend?: string;
  mutants: number;
  /** Mutants whose file is in no TypeScript project and so was not checked (always viable). */
  unchecked: number;
  /** Mutants whose source text no longer matches the file (it changed after instrumentation): not checked, never rejected. */
  stale: number;
  rejected: number;
  /** Backend passes: one per group, one per single re-check, one per baseline. */
  passes: number;
  groups: number;
  singles: number;
  /** Files diagnosed across all passes. */
  fileChecks: number;
  initMs: number;
  checkMs: number;
}

export interface TypeChecker {
  /** Per mutant number, the first new diagnostic of each mutant the checker rejects. */
  check(mutants: readonly MutantDescriptor[], root: string): Promise<Map<number, string>>;
  /**
   * Whether strictNullChecks is in effect for `file` (root-relative; default: the root's tsconfig).
   * The syntactic rules (`typeFilters`) assume it; undefined when no tsconfig applies.
   */
  strictNullChecks(file?: string): Promise<boolean | undefined>;
  close(): Promise<void>;
  readonly stats: TypeCheckStats;
}

interface FileState {
  abs: string;
  key: string;
  rel: string;
  source: string;
  tsconfig: string;
  lineStarts: number[];
  units: Unit[];
  /** Project files importing this file directly. */
  importers: string[];
}

interface Edit {
  m: MutantDescriptor;
  file: FileState;
  start: number;
  end: number;
  unit: number;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) starts.push(i + 1);
    else if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionOf(starts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

/** [start, end, solo]: a grouping unit, and whether its mutants must be checked alone. */
type Unit = [start: number, end: number, solo: boolean];

/**
 * Top-level statements, with a top-level class split into its members: the grouping units.
 * A top-level variable declaration without a type annotation is `solo`: a mutant in its
 * initializer changes the inferred type of a binding the rest of the file uses, so its errors
 * land in other units (measured: most of the grouping's misses on the tzap sources).
 */
function unitsOf(file: string, source: string): Unit[] {
  const program = parse(file, source).program;
  if (!program) return [[0, source.length, false]];
  const units: Unit[] = [];
  for (const stmt of program.body as Node[]) {
    let decl: Node | undefined = stmt;
    if ((stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') && stmt.declaration) decl = stmt.declaration as Node;
    if (decl && (decl.type === 'ClassDeclaration' || decl.type === 'ClassExpression')) {
      const members = ((decl.body as Node | undefined)?.body as Node[] | undefined) ?? [];
      if (members.length > 0) {
        units.push([stmt.start, members[0]!.start, false]);
        for (const m of members) units.push([m.start, m.end, m.type === 'PropertyDefinition' && !m.typeAnnotation]);
        continue;
      }
    }
    const solo = decl?.type === 'VariableDeclaration' && ((decl.declarations as Node[]) ?? []).some((d) => !(d.id as Node | undefined)?.typeAnnotation);
    units.push([stmt.start, stmt.end, solo]);
  }
  return units;
}

const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|\bexport\s*\*\s*from\s*)['"]([^'"\n]+)['"]/gm;

/** Direct importers per file, from relative specifiers only (path aliases and self-references are not followed). */
function importGraph(sources: readonly string[]): Map<string, string[]> {
  const byKey = new Map(sources.map((s) => [fileKey(s), s]));
  const importers = new Map<string, string[]>();
  const resolve = (from: string, spec: string): string | undefined => {
    const base = path.posix.join(path.posix.dirname(from), spec);
    const stem = base.replace(/\.(m|c)?jsx?$/, '');
    const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    for (const c of candidates) {
      const hit = byKey.get(fileKey(c));
      if (hit) return hit;
    }
    return undefined;
  };
  for (const s of sources) {
    let text: string;
    try {
      text = readFileSync(s, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(IMPORT_SPEC)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue;
      const target = resolve(s, spec);
      if (!target || target === s) continue;
      const k = fileKey(target);
      const list = importers.get(k) ?? [];
      if (!list.includes(s)) list.push(s);
      importers.set(k, list);
    }
  }
  return importers;
}

interface Located extends Diag {
  file: string;
  /** Checked text, for reporting line and column. */
  starts: readonly number[];
}

export function createTypeChecker(options: TypeCheckerOptions): TypeChecker {
  const root = path.resolve(options.root);
  const grouping = options.grouping ?? true;
  const maxGroup = options.maxGroup ?? 200;
  const dependents = options.dependents ?? true;
  const stats: TypeCheckStats = { mutants: 0, unchecked: 0, stale: 0, rejected: 0, passes: 0, groups: 0, singles: 0, fileChecks: 0, initMs: 0, checkMs: 0 };

  let backend: Promise<Backend> | undefined;
  const files = new Map<string, FileState | null>();
  const tsconfigByDir = new Map<string, string | undefined>();
  const graphs = new Map<string, Map<string, string[]>>();
  const baselines = new Map<string, Diag[]>();
  const diskText = new Map<string, string>();

  const nearestTsconfig = (dir: string): string | undefined => {
    if (options.tsconfig) return path.resolve(root, options.tsconfig);
    const hit = tsconfigByDir.get(dir);
    if (hit !== undefined || tsconfigByDir.has(dir)) return hit;
    let found: string | undefined;
    const candidate = path.join(dir, 'tsconfig.json');
    if (existsSync(candidate)) found = candidate;
    else {
      const parent = path.dirname(dir);
      const inside = !path.relative(root, parent).startsWith('..');
      found = parent !== dir && inside ? nearestTsconfig(parent) : undefined;
    }
    tsconfigByDir.set(dir, found);
    return found;
  };

  const getBackend = (tsconfig: string | undefined) => {
    if (!backend) {
      const t0 = performance.now();
      const from = options.resolveFrom ?? [...(tsconfig ? [path.dirname(tsconfig)] : []), root];
      backend = loadBackend(from, options.typescript ?? 'auto', root).then((b) => {
        stats.backend = `${b.kind} (typescript ${b.version})`;
        stats.initMs += performance.now() - t0;
        return b;
      });
    }
    return backend;
  };

  const fileState = async (rel: string): Promise<FileState | null> => {
    const known = files.get(rel);
    if (known !== undefined) return known;
    const abs = slash(path.resolve(root, rel));
    const tsconfig = nearestTsconfig(path.dirname(abs));
    let state: FileState | null = null;
    if (tsconfig) {
      const b = await getBackend(tsconfig);
      const t0 = performance.now();
      const info = b.project(tsconfig);
      stats.initMs += performance.now() - t0;
      const key = fileKey(abs);
      const own = info.sources.find((s) => fileKey(s) === key);
      if (own) {
        const source = readFileSync(abs, 'utf8');
        let graph = graphs.get(fileKey(tsconfig));
        if (!graph) {
          graph = dependents ? importGraph(info.sources) : new Map();
          graphs.set(fileKey(tsconfig), graph);
        }
        state = {
          abs: own,
          key,
          rel,
          source,
          tsconfig,
          lineStarts: lineStartsOf(source),
          units: grouping ? unitsOf(rel, source) : [],
          importers: graph.get(key) ?? [],
        };
      }
    }
    files.set(rel, state);
    return state;
  };

  const offsetOf = (f: FileState, p: { line: number; column: number }) => (f.lineStarts[p.line - 1] ?? f.source.length) + p.column - 1;

  const readText = (file: string) => {
    const k = fileKey(file);
    let t = diskText.get(k);
    if (t === undefined) {
      t = readFileSync(file, 'utf8');
      diskText.set(k, t);
    }
    return t;
  };

  /** One backend pass over `edits` applied together. Returns the new diagnostics per checked file. */
  const pass = async (edits: readonly Edit[]) => {
    const b = await getBackend(edits[0]?.file.tsconfig);
    const byFile = new Map<string, Edit[]>();
    for (const e of edits) {
      const list = byFile.get(e.file.key) ?? [];
      list.push(e);
      byFile.set(e.file.key, list);
    }
    // Checked files: every mutated file plus its importers, each once, under the mutated file's tsconfig.
    const checked = new Map<string, { tsconfig: string; file: string; edits: Edit[] }>();
    for (const [key, list] of byFile) {
      list.sort((a, b2) => a.start - b2.start);
      const f = list[0]!.file;
      checked.set(key, { tsconfig: f.tsconfig, file: f.abs, edits: list });
      for (const imp of f.importers) {
        const k = fileKey(imp);
        if (!checked.has(k)) checked.set(k, { tsconfig: f.tsconfig, file: imp, edits: byFile.get(k) ?? [] });
      }
    }
    const requests = [...checked.values()];
    // Baselines of files not seen before, in one unmutated pass.
    const missing = requests.filter((r) => !baselines.has(fileKey(r.file)));
    if (missing.length > 0) {
      stats.passes++;
      stats.fileChecks += missing.length;
      const diags = b.diagnose(missing, new Map());
      missing.forEach((r, i) => baselines.set(fileKey(r.file), diags[i]!));
    }
    const overlay = new Map<string, string>();
    const texts = new Map<string, string>();
    for (const [key, list] of byFile) {
      const src = list[0]!.file.source;
      let out = '';
      let at = 0;
      for (const e of list) {
        out += src.slice(at, e.start) + e.m.replacement;
        at = e.end;
      }
      out += src.slice(at);
      overlay.set(key, out);
      texts.set(key, out);
    }
    stats.passes++;
    stats.fileChecks += requests.length;
    const diags = b.diagnose(requests, overlay);
    const introduced: Array<{ req: (typeof requests)[number]; diags: Located[] }> = [];
    requests.forEach((req, i) => {
      const key = fileKey(req.file);
      const text = texts.get(key) ?? readText(req.file);
      const starts = lineStartsOf(text);
      const fresh = newDiagnostics(baselines.get(key) ?? [], diags[i]!, req.edits);
      if (fresh.length > 0) introduced.push({ req, diags: fresh.map((d) => ({ ...d, file: req.file, starts })) });
    });
    return introduced;
  };

  const format = (d: Located) => {
    const p = positionOf(d.starts, d.start);
    const rel = slash(path.relative(root, d.file));
    return `${rel}(${p.line},${p.column}): error TS${d.code}: ${d.message}`;
  };

  const checkSingle = async (e: Edit): Promise<string | undefined> => {
    stats.singles++;
    const found = await pass([e]);
    if (found.length === 0) return undefined;
    // Prefer a diagnostic in the mutated file, inside the replacement.
    const own = found.find((f) => fileKey(f.req.file) === e.file.key);
    const d = own?.diags.find((x) => inside(x, e, own.req.edits)) ?? own?.diags[0] ?? found[0]!.diags[0]!;
    return format(d);
  };

  const checkGroup = async (group: readonly Edit[], out: Map<number, string>) => {
    if (group.length === 1) {
      const r = await checkSingle(group[0]!);
      if (r !== undefined) out.set(group[0]!.m.num, r);
      return;
    }
    stats.groups++;
    const found = await pass(group);
    if (found.length === 0) return;
    const ambiguous = new Set<Edit>();
    const rejected = new Map<Edit, string>();
    for (const { req, diags } of found) {
      const own = req.edits;
      // Mutants that can have caused a diagnostic in this file: its own, and those in files it imports.
      const upstream = group.filter((e) => e.file.importers.some((imp) => fileKey(imp) === fileKey(req.file)));
      for (const d of diags) {
        const hit = own.filter((e) => inside(d, e, own));
        let cause: Edit | undefined;
        if (hit.length === 1) cause = hit[0];
        else if (hit.length === 0) {
          // A group holds at most one mutant per unit of a file: a diagnostic in a unit that holds a
          // mutant is that mutant's (a function's return type, the `return` before an expression).
          const unit = own.find((e) => withinUnit(d, e, own));
          if (unit) cause = unit;
          else if (own.length + upstream.length === 1) cause = own[0] ?? upstream[0];
        }
        if (cause) {
          if (!rejected.has(cause)) rejected.set(cause, format(d));
        } else {
          for (const e of hit.length > 0 ? hit : [...own, ...upstream]) ambiguous.add(e);
        }
      }
    }
    for (const [e, msg] of rejected) out.set(e.m.num, msg);
    for (const e of ambiguous) {
      if (rejected.has(e)) continue;
      const r = await checkSingle(e);
      if (r !== undefined) out.set(e.m.num, r);
    }
  };

  const groupsOf = (edits: readonly Edit[]): Edit[][] => {
    if (!grouping) return edits.map((e) => [e]);
    // The k-th mutant of each (file, unit) goes to round k; rounds are split at maxGroup.
    const seen = new Map<string, number>();
    const rounds: Edit[][] = [];
    const solos: Edit[][] = [];
    for (const e of edits) {
      if (e.unit >= 0 && e.file.units[e.unit]![2]) {
        solos.push([e]);
        continue;
      }
      const k = `${e.file.key}#${e.unit}`;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      (rounds[n] ??= []).push(e);
    }
    const out: Edit[][] = [];
    for (const r of rounds) for (let i = 0; i < r.length; i += maxGroup) out.push(r.slice(i, i + maxGroup));
    return [...out, ...solos];
  };

  return {
    stats,
    async check(mutants, checkRoot) {
      if (path.resolve(checkRoot) !== root) throw new Error(`typecheck: checker created for ${root}, called for ${checkRoot}`);
      const t0 = performance.now();
      const initBefore = stats.initMs;
      const out = new Map<number, string>();
      const edits: Edit[] = [];
      for (const m of mutants) {
        stats.mutants++;
        const f = await fileState(m.file);
        if (!f) {
          stats.unchecked++;
          continue;
        }
        const start = offsetOf(f, m.location.start);
        const end = offsetOf(f, m.location.end);
        // The file changed since instrumentation: splicing at stale offsets would reject a valid
        // mutant. `original` is only a guard here (truncated to 197 chars + '...' for long nodes).
        const at = f.source.slice(start, end);
        const truncated = m.original.length === 200 && m.original.endsWith('...') && at.length > 200 && at.startsWith(m.original.slice(0, 197));
        if (at !== m.original && !truncated) {
          stats.stale++;
          continue;
        }
        let unit = f.units.findIndex(([s, e]) => start >= s && end <= e);
        if (unit === -1) unit = -1 - start; // spans units: its own unit
        edits.push({ m, file: f, start, end, unit });
      }
      edits.sort((a, b) => (a.file.key < b.file.key ? -1 : a.file.key > b.file.key ? 1 : a.start - b.start));
      for (const g of groupsOf(edits)) await checkGroup(g, out);
      stats.rejected += out.size;
      stats.checkMs += performance.now() - t0 - (stats.initMs - initBefore);
      return out;
    },
    async strictNullChecks(file) {
      const dir = file ? path.dirname(path.resolve(root, file)) : root;
      const tsconfig = nearestTsconfig(dir);
      if (!tsconfig) return undefined;
      return (await getBackend(tsconfig)).project(tsconfig).strictNullChecks;
    },
    async close() {
      // A backend that failed to load has nothing to close; its error went to `check`.
      const b = await backend?.catch(() => undefined);
      b?.close();
      backend = undefined;
    },
  };
}

/** Whether diagnostic `d` (in mutated coordinates of a file with `edits`) starts inside edit `e`'s replacement. */
function inside(d: Diag, e: Edit, edits: readonly Edit[]): boolean {
  let shift = 0;
  for (const x of edits) {
    if (x === e) break;
    shift += x.m.replacement.length - (x.end - x.start);
  }
  const s = e.start + shift;
  return d.start >= s && d.start <= s + e.m.replacement.length;
}

/** Whether diagnostic `d` (mutated coordinates) lies in the grouping unit that holds edit `e`. */
function withinUnit(d: Diag, e: Edit, edits: readonly Edit[]): boolean {
  if (e.unit < 0) return false;
  const [us, ue] = e.file.units[e.unit]!;
  // Shift of every edit before the unit's start, and inside the unit (only `e` can be there).
  let before = 0;
  for (const x of edits) if (x.end <= us) before += x.m.replacement.length - (x.end - x.start);
  const grow = e.m.replacement.length - (e.end - e.start);
  return d.start >= us + before && d.start < ue + before + grow;
}

/**
 * Diagnostics of the mutated text that the original text did not have. A baseline diagnostic
 * matches a mutated one with the same code and message whose position maps back to the same
 * offset, or, when either lies in an edited region, falls in the same edited region.
 */
export function newDiagnostics(baseline: readonly Diag[], mutated: readonly Diag[], edits: ReadonlyArray<{ start: number; end: number; m: { replacement: string } }>): Diag[] {
  // Map a mutated offset back to the original: [kind, value] where kind 'at' is an exact offset, 'edit' an edit index.
  const back = (offset: number): { at: number } | { edit: number } => {
    let shift = 0;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]!;
      const s = e.start + shift;
      const len = e.m.replacement.length;
      if (offset < s) return { at: offset - shift };
      if (offset <= s + len) return { edit: i };
      shift += len - (e.end - e.start);
    }
    return { at: offset - shift };
  };
  const editOfOriginal = (offset: number) => edits.findIndex((e) => offset >= e.start && offset <= e.end);
  const pool = baseline.map((d) => ({ d, used: false, edit: editOfOriginal(d.start) }));
  const fresh: Diag[] = [];
  for (const d of mutated) {
    const b = back(d.start);
    const match = pool.find(
      (p) => !p.used && p.d.code === d.code && p.d.message === d.message && ('at' in b ? p.d.start === b.at : p.edit === b.edit),
    );
    if (match) match.used = true;
    else fresh.push(d);
  }
  return fresh;
}
