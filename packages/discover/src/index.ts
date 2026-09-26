/**
 * Discovery: computes a {@link ProjectModel} from a JS/TS repository — the analogue of jzap's
 * Gradle/Maven adapters. It reads workspace manifests, package.json files and the presence of
 * runner configuration; it never runs the user's tooling. Everything it concludes, and anything it
 * skipped, is reported in `notes` so a surprising model can be explained.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { MODEL_SCHEMA_VERSION, type PackageModel, type ProjectModel, type RunnerKind, validateModel } from '@tzap/model';
import { glob } from 'tinyglobby';
import { parse as parseYaml } from 'yaml';

export interface DiscoverOptions {
  /** Directory discovery starts from; the workspace root is found by walking up from here. */
  cwd: string;
  /** Keep only these packages, by package id or by directory (relative to the root or to `cwd`). */
  filter?: string[];
}

export interface Discovery {
  model: ProjectModel;
  /** Human-readable findings: what was found where, and anything skipped and why. */
  notes: string[];
}

const SOURCE_EXT = '{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue,svelte}';

/** Excluded from every package's sources. */
const ALWAYS_EXCLUDE = [
  '**/*.{test,spec}.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  'test/**',
  'tests/**',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
  '**/node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
];

/** Additionally excluded when sources are taken from the whole package rather than `src/`. */
const NO_SRC_EXCLUDE = ['*.config.*', '.*rc.*', 'scripts/**'];

const TEST_FILE_GLOBS = [`**/*.{test,spec}.${SOURCE_EXT}`, `**/__tests__/**/*.${SOURCE_EXT}`, `test/**/*.${SOURCE_EXT}`, `tests/**/*.${SOURCE_EXT}`];

interface PackageJson {
  name?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  workspaces?: unknown;
  jest?: unknown;
  [k: string]: unknown;
}

type WorkspaceKind = 'pnpm' | 'npm/yarn' | 'single';

interface Root {
  dir: string;
  kind: WorkspaceKind;
  /** Workspace globs (may include `!negations`); empty for a single package. */
  patterns: string[];
  pkg?: PackageJson;
}

const slash = (p: string): string => p.replace(/\\/g, '/');

function rel(from: string, to: string): string {
  const r = slash(path.relative(from, to));
  return r === '' ? '.' : r;
}

function readJson(file: string): PackageJson | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/** Workspace globs declared by a package.json: npm/yarn array form or yarn `{ packages: [] }`. */
function packageJsonWorkspaces(pkg: PackageJson): string[] | undefined {
  const ws = pkg.workspaces;
  if (ws === undefined) return undefined;
  const arr = stringArray(ws);
  if (arr) return arr;
  if (typeof ws === 'object' && ws !== null) return stringArray((ws as { packages?: unknown }).packages);
  return undefined;
}

function pnpmWorkspaces(dir: string, notes: string[]): string[] {
  const file = path.join(dir, 'pnpm-workspace.yaml');
  try {
    const doc: unknown = parseYaml(readFileSync(file, 'utf8'));
    const pkgs = typeof doc === 'object' && doc !== null ? (doc as { packages?: unknown }).packages : undefined;
    const arr = stringArray(pkgs);
    if (arr) return arr;
    notes.push(`${slash(file)}: no \`packages\` list; only the root package is part of the workspace`);
  } catch (e) {
    notes.push(`${slash(file)}: could not be read (${(e as Error).message}); only the root package is used`);
  }
  return [];
}

/** Walks up from `cwd`: the first workspace root wins, else the nearest package.json directory. */
function findRoot(cwd: string, notes: string[]): { root: Root; nearest: string | undefined } {
  let nearest: string | undefined;
  let dir = path.resolve(cwd);
  for (;;) {
    const pkgFile = path.join(dir, 'package.json');
    const pkg = existsSync(pkgFile) ? readJson(pkgFile) : undefined;
    if (pkg && nearest === undefined) nearest = dir;
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return { root: { dir, kind: 'pnpm', patterns: pnpmWorkspaces(dir, notes), ...(pkg ? { pkg } : {}) }, nearest };
    }
    if (pkg) {
      const ws = packageJsonWorkspaces(pkg);
      if (ws) return { root: { dir, kind: 'npm/yarn', patterns: ws, pkg }, nearest };
      if (pkg.workspaces !== undefined) notes.push(`${slash(pkgFile)}: \`workspaces\` has an unrecognised shape, ignored`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (nearest === undefined) {
    throw new Error(`no package.json found in ${slash(path.resolve(cwd))} or any parent directory`);
  }
  return { root: { dir: nearest, kind: 'single', patterns: [], pkg: readJson(path.join(nearest, 'package.json')) ?? {} }, nearest };
}

/** Expands workspace globs to package directories (absolute). Negations exclude. */
async function expandWorkspaces(rootDir: string, patterns: string[]): Promise<string[]> {
  const clean = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  const positive = patterns.filter((p) => !p.startsWith('!')).map(clean);
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => clean(p.slice(1)));
  if (positive.length === 0) return [];
  const toManifest = (p: string) => (p === '.' ? 'package.json' : `${p}/package.json`);
  const files = await glob(positive.map(toManifest), {
    cwd: rootDir,
    ignore: ['**/node_modules/**', ...negative.map(toManifest)],
    onlyFiles: true,
    dot: false,
    expandDirectories: false,
  });
  return [...new Set(files.map((f) => path.resolve(rootDir, path.dirname(f))))];
}

function allDeps(pkg: PackageJson | undefined): Set<string> {
  const out = new Set<string>();
  if (!pkg) return out;
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const d = pkg[k];
    if (typeof d === 'object' && d !== null) for (const name of Object.keys(d)) out.add(name);
  }
  return out;
}

function testScript(pkg: PackageJson): string | undefined {
  const t = pkg.scripts?.test;
  return typeof t === 'string' ? t : undefined;
}

/** Does a shell command invoke `bin` as a command (not merely mention it in a path)? */
function invokes(script: string | undefined, bin: string): boolean {
  if (!script) return false;
  return new RegExp(`(^|[\\s;&|(/"'])${bin}(?=$|[\\s;&|)"'])`).test(script);
}

function usesNodeTest(script: string | undefined): boolean {
  if (!script) return false;
  return script.split(/&&|\|\||;|\|/).some((cmd) => /(^|\s)node(\.exe)?\s/.test(cmd) && /(^|\s)--test(\s|=|$)/.test(cmd));
}

const configRe = (base: string) => new RegExp(`^${base.replace(/\./g, '\\.')}\\.(m|c)?[jt]s$`);

/** Finds the installed runner's version the way Node would resolve it from the package directory. */
function runnerVersion(name: string, pkgDir: string): string | undefined {
  const req = createRequire(path.join(pkgDir, 'package.json'));
  try {
    const found = req.resolve(`${name}/package.json`);
    // Only an install in a node_modules above the package is the project's own; a global or
    // host-process path is not what the project's test command would run.
    const within = (p: string) => path.resolve(pkgDir).toLowerCase().startsWith(path.dirname(p.slice(0, p.toLowerCase().lastIndexOf(`${path.sep}node_modules${path.sep}`) + 1)).toLowerCase());
    const v = within(found) ? readJson(found)?.version : undefined;
    if (typeof v === 'string') return v;
  } catch {
    // `package.json` may not be exported; fall back to walking node_modules directories.
  }
  let dir = pkgDir;
  for (;;) {
    const file = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(file)) {
      const v = readJson(file)?.version;
      if (typeof v === 'string') return v;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface Detected {
  kind: RunnerKind;
  config?: string;
  why: string;
}

function detectRunner(pkgDir: string, pkg: PackageJson, rootPkg: PackageJson | undefined, isMonorepoMember: boolean): Detected | undefined {
  let files: string[] = [];
  try {
    files = readdirSync(pkgDir);
  } catch {
    // unreadable directory: no config files
  }
  const find = (re: RegExp) => files.filter((f) => re.test(f)).sort()[0];
  const deps = allDeps(pkg);
  const rootDeps = isMonorepoMember ? allDeps(rootPkg) : new Set<string>();
  const script = testScript(pkg);
  const viaRoot = (bin: string) => rootDeps.has(bin) && invokes(script, bin);
  const abs = (f: string) => path.join(pkgDir, f);

  // vitest
  const vitestConfig = find(configRe('vitest.config'));
  if (vitestConfig) return { kind: 'vitest', config: abs(vitestConfig), why: `config file ${vitestConfig}` };
  const viteConfig = find(configRe('vite.config'));
  if (viteConfig) {
    let text = '';
    try {
      text = readFileSync(abs(viteConfig), 'utf8');
    } catch {
      // unreadable: treat as no test key
    }
    if (/\btest\s*:/.test(text)) return { kind: 'vitest', config: abs(viteConfig), why: `\`test\` key in ${viteConfig}` };
  }
  const vitestWorkspace = find(/^vitest\.workspace\.(m|c)?[jt]s$|^vitest\.workspace\.json$/);
  if (vitestWorkspace) return { kind: 'vitest', config: abs(vitestWorkspace), why: `workspace file ${vitestWorkspace}` };
  if (deps.has('vitest')) return { kind: 'vitest', why: 'vitest in package dependencies' };
  if (viaRoot('vitest')) return { kind: 'vitest', why: 'test script runs vitest, installed at the workspace root' };

  // jest
  const jestConfig = find(/^jest\.config\.(m|c)?[jt]s$|^jest\.config\.json$/);
  if (jestConfig) return { kind: 'jest', config: abs(jestConfig), why: `config file ${jestConfig}` };
  if (pkg.jest !== undefined) return { kind: 'jest', why: '`jest` key in package.json' };
  if (deps.has('jest')) return { kind: 'jest', why: 'jest in package dependencies' };
  if (viaRoot('jest')) return { kind: 'jest', why: 'test script runs jest, installed at the workspace root' };

  // mocha
  const mochaRc = find(/^\.mocharc\.(js|cjs|mjs|json|jsonc|yaml|yml)$/);
  if (mochaRc) return { kind: 'mocha', config: abs(mochaRc), why: `config file ${mochaRc}` };
  if (deps.has('mocha')) return { kind: 'mocha', why: 'mocha in package dependencies' };
  if (viaRoot('mocha')) return { kind: 'mocha', why: 'test script runs mocha, installed at the workspace root' };

  // node:test
  if (usesNodeTest(script)) return { kind: 'node', why: 'test script uses `node --test`' };

  // Last resort: the test script names a runner binary nobody declares (hoisted or global install).
  for (const bin of ['vitest', 'jest', 'mocha'] as const) {
    if (invokes(script, bin)) return { kind: bin, why: `test script runs ${bin} (not declared in any dependencies)` };
  }
  return undefined;
}

async function hasTestFiles(pkgDir: string): Promise<boolean> {
  const found = await glob(TEST_FILE_GLOBS, { cwd: pkgDir, ignore: ['**/node_modules/**', 'dist/**', 'build/**', 'coverage/**'], onlyFiles: true });
  return found.length > 0;
}

async function describePackage(
  rootDir: string,
  pkgDir: string,
  pkg: PackageJson,
  rootPkg: PackageJson | undefined,
  isMonorepoMember: boolean,
  notes: string[],
): Promise<PackageModel> {
  const pkgRoot = rel(rootDir, pkgDir);
  const id = typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : pkgRoot;
  const label = `${id} (${pkgRoot})`;
  if (id === pkgRoot && pkg.name === undefined) notes.push(`${label}: package.json has no name; using its directory as the id`);

  const hasSrc = isDir(path.join(pkgDir, 'src'));
  const sources = hasSrc ? [`src/**/*.${SOURCE_EXT}`] : [`**/*.${SOURCE_EXT}`];
  const exclude = hasSrc ? [...ALWAYS_EXCLUDE] : [...ALWAYS_EXCLUDE, ...NO_SRC_EXCLUDE];
  if (!hasSrc) notes.push(`${label}: no src/ directory; sources are every script file in the package, minus config files and scripts/`);

  const out: PackageModel = { id, root: pkgRoot, sources, exclude };

  const tsconfig = path.join(pkgDir, 'tsconfig.json');
  if (existsSync(tsconfig)) out.tsconfig = rel(rootDir, tsconfig);

  const detected = detectRunner(pkgDir, pkg, rootPkg, isMonorepoMember);
  if (detected) {
    out.runner = { kind: detected.kind };
    if (detected.config) out.runner.config = rel(rootDir, detected.config);
    if (detected.kind === 'node') {
      notes.push(`${label}: runner node:test (${detected.why}); it runs on the Node that runs tzap`);
    } else {
      const version = runnerVersion(detected.kind, pkgDir);
      if (version) out.runner.version = version;
      notes.push(
        `${label}: runner ${detected.kind}${version ? ` ${version}` : ''} (${detected.why})` +
          (version ? '' : `; ${detected.kind} is not installed where Node would resolve it from ${pkgRoot}, so no version is recorded`),
      );
    }
  } else {
    const script = testScript(pkg);
    const testFiles = await hasTestFiles(pkgDir);
    if (script !== undefined) {
      notes.push(`${label}: test script ${JSON.stringify(script)} does not use a supported runner (vitest, jest, mocha, node --test); treated as a mutation source only`);
    } else {
      notes.push(`${label}: no test runner and no test script; a mutation source only, its mutants are killed by other packages' tests`);
    }
    if (testFiles) {
      notes.push(`${label}: has test files, but no runner was detected to run them`);
    } else {
      out.tests = [];
    }
  }
  return out;
}

/** A root Vitest config that declares `projects` (Vitest 3+) or a legacy workspace file. */
function rootProjectsConfig(dir: string): string | undefined {
  for (const base of ['vitest.config', 'vite.config']) {
    for (const ext of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']) {
      const f = path.join(dir, `${base}.${ext}`);
      try {
        if (/\bprojects\s*:|\bworkspace\s*:/.test(readFileSync(f, 'utf8'))) return f;
      } catch {
        // not there
      }
    }
  }
  return undefined;
}

function applyFilter(packages: PackageModel[], filter: string[], rootDir: string, cwd: string, notes: string[]): PackageModel[] {
  const wanted = new Set<string>();
  for (const f of filter) {
    wanted.add(f);
    const norm = slash(f).replace(/^\.\//, '').replace(/\/+$/, '');
    wanted.add(norm === '' ? '.' : norm);
    const fromCwd = path.resolve(cwd, f);
    if (isDir(fromCwd)) wanted.add(rel(rootDir, fromCwd));
  }
  const kept = packages.filter((p) => wanted.has(p.id) || wanted.has(p.root));
  if (kept.length === 0) {
    throw new Error(`filter ${JSON.stringify(filter)} matched no package; found: ${packages.map((p) => `${p.id} (${p.root})`).join(', ')}`);
  }
  notes.push(`filter kept ${kept.length} of ${packages.length} packages: ${kept.map((p) => p.id).join(', ')}`);
  return kept;
}

/** Computes the project model for the repository containing `opts.cwd`. */
export async function discover(opts: DiscoverOptions): Promise<Discovery> {
  const notes: string[] = [];
  const cwd = path.resolve(opts.cwd);
  const found = findRoot(cwd, notes);
  let root = found.root;
  let members: string[] = [];

  if (root.kind !== 'single') {
    members = await expandWorkspaces(root.dir, root.patterns);
    // A workspace far above the nearest package that does not list it is not this project's.
    const nearest = found.nearest;
    if (nearest && nearest !== root.dir && !members.includes(nearest)) {
      notes.push(
        `${slash(root.dir)} is a workspace, but ${slash(nearest)} is not one of its packages; treating ${slash(nearest)} as a single-package project`,
      );
      root = { dir: nearest, kind: 'single', patterns: [], pkg: readJson(path.join(nearest, 'package.json')) ?? {} };
      members = [];
    }
  }

  const rootDir = root.dir;
  const packages: PackageModel[] = [];
  if (root.kind === 'single') {
    notes.push(`root ${slash(rootDir)}: single-package project`);
    packages.push(await describePackage(rootDir, rootDir, root.pkg ?? {}, root.pkg, false, notes));
  } else {
    const source = root.kind === 'pnpm' ? 'pnpm-workspace.yaml' : 'package.json workspaces';
    notes.push(`root ${slash(rootDir)}: ${root.kind} workspace (${source}: ${root.patterns.join(', ') || 'none'})`);
    if (members.length === 0 && root.pkg) {
      notes.push('workspace globs matched no package; using the root package');
      members = [rootDir];
    }
    if (root.pkg && !members.includes(rootDir)) {
      notes.push('the workspace root package.json is not a workspace package (tooling only); skipped');
    }
    for (const dir of members.sort()) {
      const pkg = readJson(path.join(dir, 'package.json'));
      if (!pkg) {
        notes.push(`${rel(rootDir, dir)}/package.json: not valid JSON; skipped`);
        continue;
      }
      packages.push(await describePackage(rootDir, dir, pkg, root.pkg, dir !== rootDir, notes));
    }
  }

  // One Vitest config at the root that lists the packages as projects runs every package's
  // tests: model it as one package owning every member's sources, so one session runs them all
  // and a test anywhere can kill a mutant anywhere.
  const rootVitest = root.kind !== 'single' ? rootProjectsConfig(rootDir) : undefined;
  if (rootVitest && !opts.filter?.length) {
    const prefix = (p: PackageModel, g: string) => (p.root === '.' ? g : `${p.root}/${g}`);
    const sources = packages.flatMap((p) => p.sources.map((g) => prefix(p, g)));
    const exclude = packages.flatMap((p) => (p.exclude ?? []).map((g) => prefix(p, g)));
    const version = runnerVersion('vitest', rootDir);
    const id = typeof root.pkg?.name === 'string' ? root.pkg.name : 'root';
    notes.push(`${rel(rootDir, rootVitest)} lists Vitest projects: one run at the root covers ${packages.length} packages`);
    packages.length = 0;
    packages.push({ id, root: '.', sources, ...(exclude.length ? { exclude } : {}), runner: { kind: 'vitest', config: rel(rootDir, rootVitest), ...(version ? { version } : {}) } });
  }

  packages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = opts.filter && opts.filter.length > 0 ? applyFilter(packages, opts.filter, rootDir, cwd, notes) : packages;

  const model: ProjectModel = { schemaVersion: MODEL_SCHEMA_VERSION, root: slash(rootDir), packages: selected };
  const { warnings } = validateModel(model);
  notes.push(...warnings);
  return { model, notes };
}
