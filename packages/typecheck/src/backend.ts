/**
 * The two ways tzap talks to the project's own TypeScript:
 *
 * - `ts7`: TypeScript 7 is the Go compiler. Its only programmatic surface until 7.1 is
 *   `typescript/unstable/sync` (a JSON-RPC client over the `tsc --api` process). The classic
 *   JavaScript compiler API is **absent** from the 7.x package: its `.` export is
 *   `lib/version.cjs`, which exports nothing but `version` and `versionMajorMinor`.
 *   Mutated text reaches the Go process through the virtual file system's `readFile` callback;
 *   a snapshot update with the file marked changed makes it re-read just that file.
 * - `ts6`: the classic compiler API (`typescript` <= 6.x) through a language service whose host
 *   serves mutated text from memory and bumps the file's version.
 *
 * `typescript` is always resolved from the user's project, never bundled.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Diag {
  code: number;
  /** UTF-16 offsets in the text that was checked. */
  start: number;
  end: number;
  message: string;
}

export interface ProjectInfo {
  /** Absolute, forward-slash names of the project's own source files (no declaration files, nothing under node_modules). */
  sources: string[];
  /** strictNullChecks in effect (explicit, via `strict`, or by default: `strict` is on by default since TypeScript 6.0). */
  strictNullChecks: boolean;
}

export interface Backend {
  readonly kind: 'ts7' | 'ts6';
  readonly version: string;
  /** Opens a tsconfig (idempotent). */
  project(tsconfig: string): ProjectInfo;
  /**
   * Error diagnostics (syntactic and semantic) of each requested file, with `overlay` (keyed by
   * {@link fileKey}) in place of the disk content. Files absent from the overlay read from disk.
   */
  diagnose(requests: ReadonlyArray<{ tsconfig: string; file: string }>, overlay: ReadonlyMap<string, string>): Diag[][];
  close(): void;
}

export type TypeScriptChoice = 'auto' | 6 | 7;

/**
 * Codes that never make a mutant invalid, as in Stryker's checker (which forces
 * `allowUnreachableCode`, `noUnusedLocals: false` and `noUnusedParameters: false`): a mutant that
 * leaves a variable unused or code unreachable is still a program.
 */
const IGNORED_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 7027, 7028]);

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

export const slash = (p: string) => p.replaceAll('\\', '/');
/** Overlay key: forward slashes, lower-cased on case-insensitive file systems. */
export const fileKey = (p: string) => (caseInsensitive ? slash(p).toLowerCase() : slash(p));

const isOwnSource = (f: string) => !/\/node_modules\//.test(f) && !/\.d\.[cm]?ts$/.test(f);

const strictNulls = (o: { strict?: boolean; strictNullChecks?: boolean }, major: number) => o.strictNullChecks ?? o.strict ?? major >= 6;

interface Resolved {
  dir: string;
  version: string;
  major: number;
}

function resolveTypeScript(from: readonly string[]): Resolved | undefined {
  for (const dir of from) {
    try {
      const req = createRequire(path.join(dir, '__tzap__.js'));
      const pkgPath = req.resolve('typescript/package.json');
      const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
      return { dir: path.dirname(pkgPath), version, major: Number(version.split('.')[0]) };
    } catch {
      // not resolvable from here; try the next directory
    }
  }
  return undefined;
}

/** Loads the backend for the project's own `typescript`, resolved from `from` (first hit wins). */
export async function loadBackend(from: readonly string[], choice: TypeScriptChoice, cwd: string): Promise<Backend> {
  const ts = resolveTypeScript(from);
  if (!ts) throw new Error(`typecheck: no 'typescript' package resolvable from ${from.join(', ')}; install it in the project or pass --typecheck off`);
  if (choice === 7 && ts.major < 7) throw new Error(`typecheck: TypeScript 7 requested but the project has typescript ${ts.version}`);
  if (choice === 6 && ts.major >= 7) {
    throw new Error(`typecheck: the classic compiler API was requested, but typescript ${ts.version} does not ship it (7.x exposes only typescript/unstable/*)`);
  }
  if (ts.major >= 7) return loadTs7(ts, cwd);
  return loadTs6(ts);
}

// --- TypeScript 7 (Go) ------------------------------------------------------------------

interface Ts7Diagnostic {
  pos: number;
  end: number;
  code: number;
  category: number;
  text: string;
  messageChain?: readonly Ts7Diagnostic[];
}
interface Ts7Program {
  getSourceFileNames(): readonly string[];
  getSyntacticDiagnostics(file: string): readonly Ts7Diagnostic[];
  getSemanticDiagnostics(file: string): readonly Ts7Diagnostic[];
}
interface Ts7Snapshot {
  getProject(configFileName: string): { program: Ts7Program; compilerOptions: { strict?: boolean; strictNullChecks?: boolean } } | undefined;
  dispose(): void;
}
interface Ts7Api {
  updateSnapshot(params?: { openProjects?: string[]; fileChanges?: { changed?: string[] } }): Ts7Snapshot;
  close(): void;
}

function flatten7(d: Ts7Diagnostic, out: string[] = [], depth = 0): string[] {
  out.push('  '.repeat(depth) + d.text);
  for (const c of d.messageChain ?? []) flatten7(c, out, depth + 1);
  return out;
}

async function loadTs7(ts: Resolved, cwd: string): Promise<Backend> {
  const mod = (await import(pathToFileURL(path.join(ts.dir, 'dist/api/sync/api.js')).href)) as { API: new (o: unknown) => Ts7Api };
  let overlay: ReadonlyMap<string, string> = new Map();
  const api = new mod.API({ cwd, fs: { readFile: (f: string) => overlay.get(fileKey(f)) } });
  const opened = new Map<string, ProjectInfo>();
  let snapshot: Ts7Snapshot | undefined;
  /** Files whose served content differs from disk in the current snapshot. */
  let dirty = new Map<string, string>();

  const update = (params: { openProjects?: string[]; fileChanges?: { changed?: string[] } }) => {
    const next = api.updateSnapshot(params);
    snapshot?.dispose();
    snapshot = next;
    return next;
  };

  const project = (tsconfig: string): ProjectInfo => {
    const key = fileKey(tsconfig);
    const known = opened.get(key);
    if (known) return known;
    const snap = update({ openProjects: [slash(tsconfig)] });
    const p = snap.getProject(slash(tsconfig));
    if (!p) throw new Error(`typecheck: TypeScript could not open ${tsconfig}`);
    const info = { sources: p.program.getSourceFileNames().map(slash).filter(isOwnSource), strictNullChecks: strictNulls(p.compilerOptions, ts.major) };
    opened.set(key, info);
    return info;
  };

  return {
    kind: 'ts7',
    version: ts.version,
    project,
    diagnose(requests, next) {
      for (const r of requests) project(r.tsconfig);
      // Changed since the last snapshot: files entering, leaving or changing in the overlay.
      const changed: string[] = [];
      const nextDirty = new Map<string, string>();
      for (const [k, text] of next) {
        nextDirty.set(k, text);
        if (dirty.get(k) !== text) changed.push(k);
      }
      for (const k of dirty.keys()) if (!next.has(k)) changed.push(k);
      overlay = next;
      dirty = nextDirty;
      const snap = changed.length > 0 || !snapshot ? update({ fileChanges: { changed } }) : snapshot;
      return requests.map(({ tsconfig, file }) => {
        const p = snap.getProject(slash(tsconfig));
        if (!p) return [];
        const f = slash(file);
        const all = [...p.program.getSyntacticDiagnostics(f), ...p.program.getSemanticDiagnostics(f)];
        return all
          .filter((d) => d.category === 1 && !IGNORED_CODES.has(d.code))
          .map((d) => ({ code: d.code, start: d.pos, end: d.end, message: flatten7(d).join('\n') }));
      });
    },
    close() {
      snapshot?.dispose();
      api.close();
    },
  };
}

// --- TypeScript <= 6 (classic JS API) ----------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the classic API is loaded from the user's project, untyped here on purpose */
function loadTs6(ts: Resolved): Backend {
  const req = createRequire(path.join(ts.dir, 'package.json'));
  const tsm: any = req(ts.dir);
  if (typeof tsm.createLanguageService !== 'function') throw new Error(`typecheck: typescript ${ts.version} has no createLanguageService`);
  const disk = new Map<string, string | undefined>();
  const readDisk = (f: string) => {
    const k = fileKey(f);
    if (!disk.has(k)) disk.set(k, tsm.sys.readFile(f));
    return disk.get(k);
  };
  let overlay: ReadonlyMap<string, string> = new Map();
  /** Version per file key; bumped whenever the text served for the file changes. */
  const versions = new Map<string, number>();
  const served = new Map<string, string | undefined>();
  const services = new Map<string, { ls: any; info: ProjectInfo }>();

  const open = (tsconfig: string) => {
    const key = fileKey(tsconfig);
    const known = services.get(key);
    if (known) return known;
    const read = tsm.readConfigFile(tsconfig, tsm.sys.readFile);
    if (read.error) throw new Error(`typecheck: ${tsm.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
    const parsed = tsm.parseJsonConfigFileContent(read.config, tsm.sys, path.dirname(tsconfig), undefined, tsconfig);
    const options = { ...parsed.options, noEmit: true };
    const host = {
      getScriptFileNames: () => parsed.fileNames,
      getScriptVersion: (f: string) => String(versions.get(fileKey(f)) ?? 0),
      getScriptSnapshot: (f: string) => {
        const text = overlay.get(fileKey(f)) ?? readDisk(f);
        return text === undefined ? undefined : tsm.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => path.dirname(tsconfig),
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o: unknown) => tsm.getDefaultLibFilePath(o),
      getProjectReferences: () => parsed.projectReferences,
      fileExists: (f: string) => overlay.has(fileKey(f)) || tsm.sys.fileExists(f),
      readFile: (f: string) => overlay.get(fileKey(f)) ?? readDisk(f),
      readDirectory: tsm.sys.readDirectory,
      directoryExists: tsm.sys.directoryExists,
      getDirectories: tsm.sys.getDirectories,
      realpath: tsm.sys.realpath,
      useCaseSensitiveFileNames: () => !caseInsensitive,
    };
    // One registry per service: a shared one hands a SourceFile updated by one service to another
    // that computes its incremental edit against an older version, corrupting the parse.
    const ls = tsm.createLanguageService(host, tsm.createDocumentRegistry(!caseInsensitive));
    const program = ls.getProgram();
    const sources: string[] = program
      .getSourceFiles()
      .map((sf: any) => slash(sf.fileName))
      .filter(isOwnSource);
    const entry = { ls, info: { sources, strictNullChecks: strictNulls(parsed.options, ts.major) } };
    services.set(key, entry);
    return entry;
  };

  return {
    kind: 'ts6',
    version: ts.version,
    project: (tsconfig) => open(tsconfig).info,
    diagnose(requests, next) {
      const keys = new Set([...next.keys(), ...served.keys()]);
      for (const k of keys) {
        const text = next.get(k);
        if (served.get(k) !== text) {
          versions.set(k, (versions.get(k) ?? 0) + 1);
          if (text === undefined) served.delete(k);
          else served.set(k, text);
        }
      }
      overlay = next;
      return requests.map(({ tsconfig, file }) => {
        const { ls } = open(tsconfig);
        const all = [...ls.getSyntacticDiagnostics(file), ...ls.getSemanticDiagnostics(file)];
        return all
          .filter((d: any) => d.category === 1 && !IGNORED_CODES.has(d.code))
          .map((d: any) => ({
            code: d.code as number,
            start: (d.start ?? 0) as number,
            end: ((d.start ?? 0) + (d.length ?? 0)) as number,
            message: tsm.flattenDiagnosticMessageText(d.messageText, '\n') as string,
          }));
      });
    },
    close() {
      for (const { ls } of services.values()) ls.dispose();
      services.clear();
    },
  };
}
