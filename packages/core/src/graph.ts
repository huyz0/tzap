/**
 * A static import graph: which files a file can reach through `import`, `export ... from`,
 * `require` and `import()` with literal specifiers. An over-approximation by design, used where
 * being wrong in the other direction would be unsound: the cache's invalidation (a verdict is
 * reused only if nothing its tests can reach has changed) and the narrowing of a diff run's
 * coverage phase (only tests that can reach a changed file are run).
 *
 * A computed specifier (`import(name)`, `require(x)`) makes the reach of that file unknowable,
 * and is reported so callers can widen to everything. So does a bare specifier that is neither a
 * Node built-in, an installed package, a workspace package nor a tsconfig path: a bundler alias or
 * a virtual module, which could lead anywhere.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
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
  /** A computed import or require, or an import nothing resolves, makes this file's reach unknowable. */
  dynamic: boolean;
  /** The module may keep mutable state between calls: see `mayHoldState`. */
  stateful: boolean;
  hash: string;
}

export interface GraphOptions {
  /** Workspace package name -> absolute directory, so `@acme/lib` reaches that package's files. */
  workspacePackages?: ReadonlyMap<string, string>;
  /**
   * The repository: a bare import whose `node_modules` entry links to a directory inside it (and
   * outside any `node_modules`) is a workspace package too, as the package manager's link makes
   * it. That covers workspace members the model does not list as packages of their own.
   */
  root?: string;
  /**
   * The source files under a workspace package's directory (given with symlinks resolved). A
   * closure that enters the package walks them, and so whatever they import in turn, other
   * workspace packages included.
   */
  filesUnder?: (dir: string) => readonly string[];
  /** tsconfig `paths` as absolute-target patterns, e.g. `@/*` -> [`/repo/src/*`]. */
  paths?: ReadonlyMap<string, string[]>;
}

const BUILTINS = new Set(builtinModules);

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveLocal(from: string, spec: string): string | undefined {
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

function specifiers(file: string, source: string): { specs: string[]; dynamic: boolean; stateful: boolean } {
  const specs: string[] = [];
  let dynamic = false;
  let r: ReturnType<typeof parseSync>;
  try {
    r = parseSync(file, source, { preserveParens: false });
  } catch {
    return { specs, dynamic: true, stateful: true };
  }
  const stateful = mayHoldState(r.program as unknown as { body: StmtNode[] });
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
  return { specs, dynamic, stateful };
}

interface StmtNode {
  type: string;
  [k: string]: unknown;
}

/** Calls that register tests or hooks: a test file's top-level statements, not module state. */
const TEST_APIS = new Set(['describe', 'it', 'test', 'suite', 'bench', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'before', 'after', 'context', 'specify', 'xit', 'xdescribe', 'fit', 'fdescribe']);

/** `describe(...)`, `it.each(...)(...)`, `vi.mock(...)`: a test file registering tests or mocks. */
function isTestRegistration(e: StmtNode | undefined): boolean {
  let n = e;
  while (n && n.type === 'CallExpression') n = n.callee as StmtNode;
  while (n && n.type === 'MemberExpression') {
    const obj = n.object as StmtNode;
    if (obj.type === 'Identifier' && (obj.name === 'vi' || obj.name === 'jest')) return true;
    n = obj;
    while (n && n.type === 'CallExpression') n = n.callee as StmtNode;
  }
  return !!n && n.type === 'Identifier' && TEST_APIS.has(n.name as string);
}

/** A path with symlinks resolved, or as given when it does not exist. */
export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Whether a module may keep mutable state between calls — what a warm run of a test can leave
 * behind for the next run to find. Syntactic and deliberately broad: any top-level `let`/`var`,
 * a `const` holding an object, array, instance or call result, a class with static fields, or a
 * top-level statement run for its side effect. A module of functions, classes and constant
 * primitives cannot hold state; nearly anything else might.
 */
export function mayHoldState(program: { body: StmtNode[] }): boolean {
  const statelessInit = (init: StmtNode | null | undefined): boolean => {
    if (!init) return true;
    switch (init.type) {
      case 'Literal':
        return !(init.regex && /[gy]/.test((init.regex as { flags: string }).flags));
      case 'TemplateLiteral':
        return (init.expressions as unknown[]).length === 0;
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'Identifier':
        return true;
      case 'ClassExpression':
        return !hasStaticState(init);
      case 'UnaryExpression':
        return statelessInit(init.argument as StmtNode);
      case 'BinaryExpression':
      case 'LogicalExpression':
        return statelessInit(init.left as StmtNode) && statelessInit(init.right as StmtNode);
      case 'ConditionalExpression':
        return statelessInit(init.test as StmtNode) && statelessInit(init.consequent as StmtNode) && statelessInit(init.alternate as StmtNode);
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
        return statelessInit(init.expression as StmtNode);
      default:
        return false;
    }
  };
  const hasStaticState = (cls: StmtNode): boolean =>
    ((cls.body as { body: StmtNode[] }).body ?? []).some((m) => (m.type === 'PropertyDefinition' && m.static === true && m.value != null) || m.type === 'StaticBlock');
  const statement = (s: StmtNode): boolean => {
    switch (s.type) {
      case 'ImportDeclaration':
      case 'FunctionDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
      case 'TSDeclareFunction':
      case 'EmptyStatement':
      case 'ExportAllDeclaration':
        return false;
      case 'ClassDeclaration':
        return hasStaticState(s);
      case 'VariableDeclaration':
        if (s.declare === true) return false;
        if (s.kind !== 'const') return true;
        return !(s.declarations as StmtNode[]).every((d) => statelessInit(d.init as StmtNode | null));
      case 'ExportNamedDeclaration':
        return s.declaration ? statement(s.declaration as StmtNode) : false;
      case 'ExportDefaultDeclaration': {
        const d = s.declaration as StmtNode;
        if (d.type === 'FunctionDeclaration' || d.type === 'FunctionExpression' || d.type === 'ArrowFunctionExpression') return false;
        if (d.type === 'ClassDeclaration' || d.type === 'ClassExpression') return hasStaticState(d);
        return !statelessInit(d);
      }
      case 'ExpressionStatement':
        // "use strict" is a directive, not an effect; registering tests is not module state.
        if (typeof s.directive === 'string') return false;
        return !isTestRegistration(s.expression as StmtNode);
      default:
        return true;
    }
  };
  return program.body.some(statement);
}

export class ImportGraph {
  private readonly nodes = new Map<string, FileNode>();
  /** Workspace package name -> its directory, as resolved so far. */
  private readonly packageDirs = new Map<string, string>();
  private readonly linked = new Map<string, string | undefined>();
  private readonly root: string | undefined;
  private readonly realRoot: string | undefined;
  constructor(private readonly options: GraphOptions = {}) {
    for (const [name, dir] of options.workspacePackages ?? []) this.packageDirs.set(name, realPath(path.resolve(dir)));
    this.root = options.root ? path.resolve(options.root) : undefined;
    this.realRoot = this.root ? realPath(this.root) : undefined;
  }

  /** The workspace directory a bare package name resolves to from `dir`, through node_modules links. */
  private workspaceDir(name: string, from: string): string | undefined {
    const known = this.packageDirs.get(name);
    if (known !== undefined) return known;
    const root = this.realRoot;
    if (!root) return undefined;
    for (let d = path.dirname(from); ; d = path.dirname(d)) {
      const key = `${d}\0${name}`;
      if (this.linked.has(key)) return this.linked.get(key);
      const candidate = path.join(d, 'node_modules', name);
      let found: string | undefined;
      if (existsSync(candidate)) {
        const real = realPath(candidate);
        const inside = real === root || real.startsWith(root + path.sep);
        found = inside && !real.split(path.sep).includes('node_modules') ? real : undefined;
        this.linked.set(key, found);
        return found;
      }
      if (d === path.dirname(d) || d === this.root || d === root) {
        this.linked.set(key, undefined);
        return undefined;
      }
    }
  }

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
    let stateful = false;
    if (/\.(m|c)?[jt]sx?$|\.vue$|\.svelte$/.test(key)) {
      const s = specifiers(key, source);
      dynamic = s.dynamic;
      stateful = s.stateful;
      for (const spec of s.specs) {
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const r = resolveLocal(key, spec);
          if (r) imports.push(r);
          continue;
        }
        const aliased = this.alias(spec);
        if (aliased.length > 0) {
          imports.push(...aliased);
          continue;
        }
        if (BUILTINS.has(spec) || spec.startsWith('node:')) continue;
        const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        const dir = this.workspaceDir(pkgName, key);
        if (dir !== undefined) {
          this.packageDirs.set(pkgName, dir);
          packages.push(pkgName);
        } else if (!this.installed(pkgName, key)) {
          dynamic = true;
        }
      }
    }
    n = { file: key, imports: [...new Set(imports)].sort(), packages: [...new Set(packages)].sort(), dynamic, stateful, hash };
    this.nodes.set(key, n);
    return n;
  }

  /**
   * The files a tsconfig path alias can name: the first target that exists for each matching
   * pattern. Several packages' tsconfigs can map one pattern differently, so every match counts.
   */
  private alias(spec: string): string[] {
    const out: string[] = [];
    for (const [pattern, targets] of this.options.paths ?? []) {
      const star = pattern.indexOf('*');
      const match =
        star === -1 ? (spec === pattern ? '' : undefined) : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) ? spec.slice(star, spec.length - (pattern.length - star - 1)) : undefined;
      if (match === undefined) continue;
      for (const t of targets) {
        const candidate = t.replace('*', match);
        const r = resolveLocal(path.join(path.dirname(candidate), '__x__'), `./${path.basename(candidate)}`);
        if (r) {
          out.push(r);
          break;
        }
      }
    }
    return out;
  }

  private readonly installedAt = new Map<string, boolean>();

  /** Whether `name` is in a `node_modules` directory at or above the importing file. */
  private installed(name: string, from: string): boolean {
    for (let d = path.dirname(from); ; d = path.dirname(d)) {
      const key = `${d}\0${name}`;
      let found = this.installedAt.get(key);
      if (found === undefined) {
        found = existsSync(path.join(d, 'node_modules', name));
        this.installedAt.set(key, found);
      }
      if (found) return true;
      if (d === path.dirname(d)) return false;
    }
  }

  /**
   * Every local file reachable from `entry`, including itself, plus whether the reach is
   * unknowable (a computed specifier somewhere) and which workspace packages it enters. Entering
   * a package reaches all of its source files, whatever the entry point imports of them.
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
      for (const p of n.packages) {
        if (packages.has(p)) continue;
        packages.add(p);
        const dir = this.packageDirs.get(p);
        if (dir !== undefined) for (const pf of this.options.filesUnder?.(dir) ?? []) stack.push(path.resolve(pf));
      }
      for (const i of n.imports) if (!seen.has(i)) stack.push(i);
    }
    return { files: [...seen].sort(), dynamic, packages: [...packages].sort() };
  }

  /**
   * A hash of every file in the closure and its content: the cache key for "nothing this test can
   * reach changed". Paths enter it relative to the root, so a cache moves between checkouts.
   */
  closureHash(entry: string): string {
    const c = this.closure(entry);
    const h = createHash('sha256');
    const name = (f: string) => (this.root ? path.relative(this.root, f).split(path.sep).join('/') : f);
    for (const f of c.files) h.update(name(f)).update('\0').update(this.node(f).hash).update('\n');
    if (c.dynamic) h.update('dynamic');
    return h.digest('hex').slice(0, 16);
  }
}
