/**
 * A static import graph: which files a file can reach through `import`, `export ... from`,
 * `require` and `import()` with literal specifiers. An over-approximation by design, used where
 * being wrong in the other direction would be unsound: the cache's invalidation (a verdict is
 * reused only if nothing its tests can reach has changed) and the narrowing of a diff run's
 * coverage phase (only tests that can reach a changed file are run).
 *
 * A computed specifier (`import(name)`, `require(x)`) makes the reach of that file unknowable,
 * and is reported so callers can widen to everything.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json'];
/** TS projects import `./x.js` meaning `./x.ts`. */
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

export interface FileNode {
  file: string;
  /** Resolved local files this one imports. */
  imports: string[];
  /** Workspace package names imported by bare specifier. */
  packages: string[];
  /** A computed import or require makes this file's reach unknowable. */
  dynamic: boolean;
  hash: string;
}

export interface GraphOptions {
  /** Workspace package name -> absolute directory, so `@acme/lib` reaches that package's files. */
  workspacePackages?: ReadonlyMap<string, string>;
  /** tsconfig `paths` as absolute-target patterns, e.g. `@/*` -> [`/repo/src/*`]. */
  paths?: ReadonlyMap<string, string[]>;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolveLocal(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  if (isFile(base)) return base;
  const ext = path.extname(base);
  for (const alt of JS_TO_TS[ext] ?? []) {
    const p = base.slice(0, -ext.length) + alt;
    if (isFile(p)) return p;
  }
  for (const e of EXTENSIONS) if (isFile(base + e)) return base + e;
  for (const e of EXTENSIONS) if (isFile(path.join(base, `index${e}`))) return path.join(base, `index${e}`);
  return undefined;
}

function specifiers(file: string, source: string): { specs: string[]; dynamic: boolean } {
  const specs: string[] = [];
  let dynamic = false;
  let r: ReturnType<typeof parseSync>;
  try {
    r = parseSync(file, source, { preserveParens: false });
  } catch {
    return { specs, dynamic: true };
  }
  const mod = r.module as unknown as {
    staticImports: Array<{ moduleRequest: { value: string } }>;
    staticExports: Array<{ entries: Array<{ moduleRequest?: { value: string } | null }> }>;
    dynamicImports: Array<{ moduleRequest: { start: number; end: number } }>;
  };
  for (const i of mod.staticImports) specs.push(i.moduleRequest.value);
  for (const e of mod.staticExports) for (const en of e.entries) if (en.moduleRequest) specs.push(en.moduleRequest.value);
  for (const d of mod.dynamicImports) {
    const text = source.slice(d.moduleRequest.start, d.moduleRequest.end).trim();
    const m = /^(['"`])([^'"`$]*)\1$/.exec(text);
    if (m) specs.push(m[2]!);
    else dynamic = true;
  }
  // require() is not in oxc's module record; a light scan is enough for literal specifiers.
  for (const m of source.matchAll(/\brequire\s*\(\s*(['"`])([^'"`$\n]*)\1\s*\)/g)) specs.push(m[2]!);
  if (/\brequire\s*\(\s*[^'"`\s)]/.test(source)) dynamic = true;
  return { specs, dynamic };
}

export class ImportGraph {
  private readonly nodes = new Map<string, FileNode>();
  constructor(private readonly options: GraphOptions = {}) {}

  node(file: string): FileNode {
    const key = path.resolve(file);
    let n = this.nodes.get(key);
    if (n) return n;
    let source = '';
    try {
      source = readFileSync(key, 'utf8');
    } catch {
      source = '';
    }
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const imports: string[] = [];
    const packages: string[] = [];
    let dynamic = false;
    if (/\.(m|c)?[jt]sx?$|\.vue$|\.svelte$/.test(key)) {
      const s = specifiers(key, source);
      dynamic = s.dynamic;
      for (const spec of s.specs) {
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const r = resolveLocal(key, spec);
          if (r) imports.push(r);
          continue;
        }
        const aliased = this.alias(spec);
        if (aliased) {
          imports.push(aliased);
          continue;
        }
        const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        if (this.options.workspacePackages?.has(pkgName)) packages.push(pkgName);
      }
    }
    n = { file: key, imports: [...new Set(imports)].sort(), packages: [...new Set(packages)].sort(), dynamic, hash };
    this.nodes.set(key, n);
    return n;
  }

  private alias(spec: string): string | undefined {
    for (const [pattern, targets] of this.options.paths ?? []) {
      const star = pattern.indexOf('*');
      const match =
        star === -1 ? (spec === pattern ? '' : undefined) : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) ? spec.slice(star, spec.length - (pattern.length - star - 1)) : undefined;
      if (match === undefined) continue;
      for (const t of targets) {
        const candidate = t.replace('*', match);
        const r = resolveLocal(path.join(path.dirname(candidate), '__x__'), `./${path.basename(candidate)}`);
        if (r) return r;
      }
    }
    return undefined;
  }

  /**
   * Every local file reachable from `entry`, including itself, plus whether the reach is
   * unknowable (a computed specifier somewhere) and which workspace packages it enters.
   */
  closure(entry: string): { files: string[]; dynamic: boolean; packages: string[] } {
    const seen = new Set<string>();
    const packages = new Set<string>();
    let dynamic = false;
    const stack = [path.resolve(entry)];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (!existsSync(f)) continue;
      const n = this.node(f);
      dynamic ||= n.dynamic;
      for (const p of n.packages) packages.add(p);
      for (const i of n.imports) if (!seen.has(i)) stack.push(i);
    }
    return { files: [...seen].sort(), dynamic, packages: [...packages].sort() };
  }

  /** A hash of every file in the closure and its content: the cache key for "nothing this test can reach changed". */
  closureHash(entry: string, extra: (pkg: string) => string[] = () => []): string {
    const c = this.closure(entry);
    const h = createHash('sha256');
    const files = new Set(c.files);
    for (const p of c.packages) for (const f of extra(p)) files.add(path.resolve(f));
    for (const f of [...files].sort()) h.update(f).update('\0').update(this.node(f).hash).update('\n');
    if (c.dynamic) h.update('dynamic');
    return h.digest('hex').slice(0, 16);
  }
}
