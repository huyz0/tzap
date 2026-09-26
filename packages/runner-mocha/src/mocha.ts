/** The parts of Mocha the executor uses, and Mocha loaded and configured as the `mocha` CLI would. */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { normPath as norm, type SessionOptions } from '@tzap/protocol';

export interface MochaRunnable {
  type: 'test' | 'hook';
  title: string;
  originalTitle?: string;
  file?: string;
  parent?: MochaSuite;
  err?: unknown;
  ctx?: { currentTest?: MochaTest };
}
export interface MochaTest extends MochaRunnable {
  type: 'test';
  fn?: unknown;
  state?: 'passed' | 'failed' | 'pending';
  pending: boolean;
  titlePath(): string[];
  fullTitle(): string;
  isPending(): boolean;
  clone(): MochaTest;
  retries(n: number): unknown;
  currentRetry(): number;
  retriedTest(): MochaTest | undefined;
}
export interface MochaHook extends MochaRunnable {
  type: 'hook';
  fn?: unknown;
}
export interface MochaSuite {
  title: string;
  file?: string;
  root: boolean;
  parent?: MochaSuite;
  tests: MochaTest[];
  suites: MochaSuite[];
  _beforeEach: MochaHook[];
  _afterEach: MochaHook[];
  _bail: boolean;
  _onlyTests: MochaTest[];
  _onlySuites: MochaSuite[];
  afterEach(title: string, fn: (this: { currentTest?: MochaTest }) => void): unknown;
}
export interface MochaRunner {
  on(event: string, f: (...args: any[]) => void): unknown;
  _eventListeners?: Map<object, Map<string, Set<(...args: any[]) => void>>>;
}
export interface MochaInstance {
  suite: MochaSuite;
  files: string[];
  version: string;
  cleanReferencesAfterRun(b: boolean): unknown;
  loadFilesAsync(): Promise<void>;
  run(fn: (failures: number) => void): MochaRunner;
  hasGlobalSetupFixtures(): boolean;
  hasGlobalTeardownFixtures(): boolean;
  runGlobalSetup(context: object): Promise<object>;
  runGlobalTeardown(context: object): Promise<object>;
}
export type MochaCtor = (new (options: object) => MochaInstance) & { interfaces: Record<string, unknown> };
export type Options = Record<string, unknown> & { _?: unknown[] };
export interface MochaCli {
  loadOptions(argv: string[]): Options;
  collectFiles(o: { ignore: string[]; extension: string[]; file: string[]; recursive: boolean; sort: boolean; spec: string[] }): string[] | { files: string[]; unmatchedFiles: unknown[] };
  handleRequires(requires: string[], o?: object): Promise<Record<string, unknown>>;
  validateLegacyPlugin?(o: Options, type: string, map: Record<string, unknown>): void;
}

/** A CLI option as a list: repeated, or comma-separated. */
export const list = (v: unknown): string[] =>
  v === undefined || v === null || v === false ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(/ *, */)).filter((x) => x !== '');

export interface MochaSetup {
  version: string;
  cli: MochaCli;
  /** The options `mocha` would run with, from the project's `.mocharc.*` / `package.json`. */
  options: Options;
  /** The test files `mocha` would run, in its order. */
  files: string[];
}

/** Mocha from the user's project, never one of tzap's own, configured as the `mocha` CLI reads its config. */
export function loadMocha(pkgRoot: string, session: SessionOptions): MochaSetup {
  const req = createRequire(path.join(pkgRoot, 'package.json'));
  let pkgJson: string;
  try {
    pkgJson = req.resolve('mocha/package.json');
  } catch {
    throw new Error(`mocha is not installed where Node resolves it from ${pkgRoot}`);
  }
  const mochaDir = path.dirname(pkgJson);
  const version = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string }).version;
  // Mocha 12 names its CommonJS files .cjs; Mocha 11 names them .js.
  const lib = (name: string) => {
    const base = path.join(mochaDir, 'lib', name);
    return req(existsSync(`${base}.cjs`) ? `${base}.cjs` : `${base}.js`);
  };
  const cliOptions = lib('cli/options') as { loadOptions: MochaCli['loadOptions'] };
  const helpers = lib('cli/run-helpers') as Pick<MochaCli, 'handleRequires' | 'validateLegacyPlugin'>;
  const cli: MochaCli = {
    loadOptions: cliOptions.loadOptions,
    collectFiles: lib('cli/collect-files') as MochaCli['collectFiles'],
    handleRequires: helpers.handleRequires,
    validateLegacyPlugin: helpers.validateLegacyPlugin,
  };
  const config = session.pkg.runner?.config;
  const options = cli.loadOptions(config ? ['--config', path.resolve(session.root, config)] : []);
  for (const k of Object.keys(options)) {
    if (!k.includes('-')) continue;
    const camel = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (!(camel in options)) options[camel] = options[k];
  }
  return { version, cli, options, files: findTestFiles(pkgRoot, cli, options, session.pkg.tests) };
}

/** The test files `mocha` would run, in its order; the model's `tests` globs replace its spec. */
function findTestFiles(pkgRoot: string, cli: MochaCli, o: Options, tests: readonly string[] | undefined): string[] {
  if (tests && tests.length === 0) return [];
  const spec = tests && tests.length > 0 ? [...tests] : (o._ ?? []).map(String);
  const r = cli.collectFiles({
    ignore: list(o.ignore),
    extension: list(o.extension),
    file: tests && tests.length > 0 ? [] : list(o.file),
    recursive: o.recursive === true,
    sort: o.sort === true,
    spec: spec.length > 0 ? spec : ['./test'],
  });
  const files = Array.isArray(r) ? r : r.files;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const abs = path.resolve(pkgRoot, f);
    if (/(^|[\\/])node_modules[\\/]/.test(path.relative(pkgRoot, abs))) continue;
    if (seen.has(norm(abs))) continue;
    seen.add(norm(abs));
    out.push(abs);
  }
  return out;
}
