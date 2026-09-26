/**
 * The incremental cache. Plain text in sorted sections, so a diff of it shows what changed.
 *
 * Reuse rules, each individually tested:
 * - Nothing changed at all (same fingerprint over every source, test and config file, same
 *   toolchain): every verdict is reused and no test runs.
 * - Killed / Timeout (from a loop or hit guard): reused when the killing test still reaches the
 *   mutant and nothing that test can reach has changed (its import-closure hash is the same).
 * - Survived: reused when exactly the same tests reach it and none of their closures changed.
 * - Never reused: a wall-clock Timeout (not reproducible), RuntimeError, and static mutants
 *   other than killed ones, which have no per-test coverage to reason about.
 * The cache records the toolchain that wrote it and is ignored under a different one.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { globSync } from 'tinyglobby';
import type { AnalysisResult, MutantDescriptor, MutantResult, ProjectModel, TestInfo } from '@tzap/model';
import type { MutantCoverage } from './engine.js';

const HEADER = '# tzap cache v1';
const FILE_NAME = 'tzap-cache.txt';

interface Entry {
  status: MutantResult['status'];
  statusReason?: string;
  killedBy?: string[];
  coveredBy?: string[];
  static?: boolean;
  testsCompleted?: number;
}

export interface Cache {
  dir: string;
  toolchain: Record<string, string>;
  fingerprint: string;
  /** True when the stored fingerprint and toolchain equal the current ones. */
  unchanged: boolean;
  entries: Map<string, Entry>;
  tests: Map<string, TestInfo>;
  killers: Map<string, string>;
  note?: string;
  reuse(m: MutantDescriptor, coverage: MutantCoverage): MutantResult | undefined;
  lookupUnchanged?: { lookup(m: MutantDescriptor): MutantResult | undefined; tests: TestInfo[] };
}

export interface CacheSettings {
  tzapVersion: string;
  mutators: readonly string[] | undefined;
  filters: readonly string[];
}

const INPUT_GLOBS = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue,svelte,json,snap}', '**/.babelrc', '**/*.lock', '**/.npmrc'];
const INPUT_IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/reports/**', '**/.tzap/**', '**/.git/**', '**/.stryker-tmp/**'];

/** A hash over every file that could change a verdict: sources, tests, snapshots, configs, lockfiles. */
export function fingerprint(model: ProjectModel): string {
  const h = createHash('sha256');
  const roots = new Set(model.packages.map((p) => path.resolve(model.root, p.root)));
  roots.add(path.resolve(model.root));
  const files = new Set<string>();
  for (const r of roots) {
    const deep = r !== path.resolve(model.root) || model.packages.some((p) => path.resolve(model.root, p.root) === r);
    const found = globSync(deep ? INPUT_GLOBS : ['*.{json,yaml,yml,lock,js,mjs,cjs,ts}'], { cwd: r, ignore: INPUT_IGNORE, absolute: true, dot: true });
    for (const f of found) files.add(path.resolve(f));
  }
  for (const f of [...files].sort()) {
    let content: Buffer;
    try {
      content = readFileSync(f);
    } catch {
      continue;
    }
    h.update(path.relative(model.root, f).replace(/\\/g, '/')).update('\0').update(content).update('\n');
  }
  return h.digest('hex').slice(0, 24);
}

function toolchainOf(model: ProjectModel, s: CacheSettings): Record<string, string> {
  const t: Record<string, string> = {
    tzap: s.tzapVersion,
    node: process.versions.node.split('.')[0]!,
    platform: process.platform,
    mutators: s.mutators ? [...s.mutators].sort().join(',') : 'all',
    filters: [...s.filters].sort().join(',') || 'none',
  };
  for (const p of model.packages) if (p.runner) t[`runner:${p.id}`] = `${p.runner.kind}@${p.runner.version ?? '?'}`;
  return t;
}

const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

export function loadCache(dir: string, model: ProjectModel, settings: CacheSettings): Cache {
  const toolchain = toolchainOf(model, settings);
  const fp = fingerprint(model);
  const entries = new Map<string, Entry>();
  const tests = new Map<string, TestInfo>();
  let storedToolchain: Record<string, string> = {};
  let storedFingerprint = '';
  let note: string | undefined;
  try {
    const text = readFileSync(path.join(dir, FILE_NAME), 'utf8');
    if (!text.startsWith(HEADER)) throw new Error('not a tzap cache');
    let section = '';
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      if (line.startsWith('[')) {
        section = line;
        continue;
      }
      const tab = line.indexOf('\t');
      const key = line.slice(0, tab);
      const value = line.slice(tab + 1);
      if (section === '[toolchain]') storedToolchain[key] = value;
      else if (section === '[fingerprint]') storedFingerprint = key || value;
      else if (section === '[tests]') tests.set(key, JSON.parse(value) as TestInfo);
      else if (section === '[mutants]') entries.set(key, JSON.parse(value) as Entry);
    }
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') note = `cache in ${dir} could not be read and is ignored: ${(e as Error).message}`;
  }
  const toolchainMatches = Object.keys(storedToolchain).length > 0 && JSON.stringify(Object.entries(storedToolchain).sort()) === JSON.stringify(Object.entries(toolchain).sort());
  if (!toolchainMatches && entries.size > 0) {
    const diff = Object.keys({ ...storedToolchain, ...toolchain }).filter((k) => storedToolchain[k] !== toolchain[k]);
    note = `cache written under a different toolchain (${diff.join(', ')}); not reused`;
    entries.clear();
    tests.clear();
  }
  const unchanged = toolchainMatches && storedFingerprint === fp;
  const killers = new Map<string, string>();
  for (const [id, e] of entries) if (e.killedBy?.[0]) killers.set(id, e.killedBy[0]);

  const cache: Cache = {
    dir,
    toolchain,
    fingerprint: fp,
    unchanged,
    entries,
    tests,
    killers,
    note,
    reuse(m, coverage) {
      const e = entries.get(m.id);
      if (!e) return undefined;
      const closureSame = (key: string) => {
        const stored = tests.get(key)?.closure;
        return stored !== undefined && stored === coverage.closures.get(key);
      };
      if (e.status === 'RuntimeError' || e.statusReason === 'wall-clock backstop') return undefined;
      if (e.status === 'Killed' || e.status === 'Timeout') {
        const killer = e.killedBy?.[0];
        if (!killer) return undefined;
        if (e.static ? !coverage.static : !coverage.tests.includes(killer)) return undefined;
        if (!closureSame(killer)) return undefined;
        return { ...m, ...e, status: e.status };
      }
      if (e.status === 'Survived' && !e.static && !coverage.static) {
        if (!sameSet(e.coveredBy, coverage.tests)) return undefined;
        if (!coverage.tests.every(closureSame)) return undefined;
        return { ...m, ...e, status: e.status };
      }
      return undefined;
    },
  };
  if (unchanged) {
    cache.lookupUnchanged = {
      lookup: (m) => {
        const e = entries.get(m.id);
        if (!e || e.status === 'RuntimeError' || e.statusReason === 'wall-clock backstop') return undefined;
        return { ...m, ...e, status: e.status };
      },
      tests: [...tests.values()],
    };
  }
  return cache;
}

export function saveCache(cache: Cache, result: AnalysisResult): void {
  // Carry forward entries this run did not decide (a diff run touches a subset).
  const entries = new Map(cache.entries);
  const tests = new Map(cache.tests);
  for (const t of result.tests) tests.set(t.id, t);
  for (const m of result.mutants) {
    if (m.status === 'Ignored' || m.status === 'Pending') continue;
    const e: Entry = { status: m.status };
    if (m.statusReason !== undefined) e.statusReason = m.statusReason;
    if (m.killedBy?.length) e.killedBy = m.killedBy;
    if (m.coveredBy?.length) e.coveredBy = m.coveredBy;
    if (m.static) e.static = true;
    if (m.testsCompleted !== undefined) e.testsCompleted = m.testsCompleted;
    entries.set(m.id, e);
  }
  const lines = [HEADER, '[toolchain]'];
  for (const [k, v] of Object.entries(cache.toolchain).sort()) lines.push(`${k}\t${v}`);
  // The fingerprint of what was analysed, taken before the run: an edit made during the run
  // must invalidate, not be absorbed.
  lines.push('[fingerprint]', `${cache.fingerprint}\t`);
  lines.push('[tests]');
  for (const [k, v] of [...tests].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`${k}\t${JSON.stringify({ id: v.id, name: v.name, file: v.file, duration: v.duration, closure: v.closure })}`);
  lines.push('[mutants]');
  for (const [k, v] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`${k}\t${JSON.stringify(v)}`);
  mkdirSync(cache.dir, { recursive: true });
  writeFileSync(path.join(cache.dir, FILE_NAME), `${lines.join('\n')}\n`);
}
