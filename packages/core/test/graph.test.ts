import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportGraph, mayHoldState } from '../src/graph.js';

const dirs: string[] = [];
/** Writes `files` (relative path -> content) into a fresh directory and returns its path. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tzap-graph-'));
  dirs.push(root);
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), content);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const rel = (root: string, files: string[]) => files.map((f) => path.relative(root, f).split(path.sep).join('/'));

describe('ImportGraph.closure', () => {
  it('follows relative imports, index files and extensionless specifiers', () => {
    const root = project({
      'test/a.test.ts': "import { f } from '../src/a';\nimport '../src/dir';\n",
      'src/a.ts': "export { g as f } from './b.js';\n",
      'src/b.ts': 'export const g = 1;\n',
      'src/dir/index.ts': 'export {};\n',
      'src/unused.ts': 'export {};\n',
    });
    const c = new ImportGraph().closure(path.join(root, 'test/a.test.ts'));
    expect(rel(root, c.files)).toEqual(['src/a.ts', 'src/b.ts', 'src/dir/index.ts', 'test/a.test.ts']);
    expect(c.dynamic).toBe(false);
    expect(c.packages).toEqual([]);
  });

  it('follows workspace packages transitively, not only the one a test imports', () => {
    const root = project({
      'a/test/a.test.ts': "import { b } from '@x/b';\n",
      'b/src/index.ts': "import { c } from '@x/c';\nexport const b = () => c;\n",
      'c/src/index.ts': "export { c } from './impl';\n",
      'c/src/impl.ts': 'export const c = 1;\n',
    });
    // The packages are named in the model; @x/c is reached only through @x/b.
    const sources = ['b/src/index.ts', 'c/src/index.ts', 'c/src/impl.ts'].map((f) => path.join(root, f));
    const options = {
      workspacePackages: new Map([['@x/b', path.join(root, 'b')], ['@x/c', path.join(root, 'c')]]),
      root,
      filesUnder: (dir: string) => sources.filter((f) => f.startsWith(dir + path.sep)),
    };
    const graph = new ImportGraph(options);
    const test = path.join(root, 'a/test/a.test.ts');
    const c = graph.closure(test);
    expect(c.packages).toEqual(['@x/b', '@x/c']);
    expect(rel(root, c.files)).toContain('c/src/impl.ts');

    // The cache key sees a change two packages away.
    const before = graph.closureHash(test);
    writeFileSync(path.join(root, 'c/src/impl.ts'), 'export const c = 2;\n');
    expect(new ImportGraph(options).closureHash(test)).not.toBe(before);
  });

  it('recognises a workspace member by its node_modules link, as the package manager made it', () => {
    const root = project({
      'packages/app/test/a.test.ts': "import { lib } from '@m/lib';\nimport 'real-dep';\n",
      'packages/lib/src/index.ts': "export { lib } from './impl';\n",
      'packages/lib/src/impl.ts': 'export const lib = 1;\n',
      'node_modules/real-dep/index.js': 'module.exports = 1;\n',
    });
    mkdirSync(path.join(root, 'node_modules/@m'), { recursive: true });
    symlinkSync(path.join(root, 'packages/lib'), path.join(root, 'node_modules/@m/lib'), 'junction');
    // One model package owns every member's sources, as with a root Vitest `projects` config.
    const sources = ['packages/lib/src/index.ts', 'packages/lib/src/impl.ts'].map((f) => path.join(root, f));
    const graph = new ImportGraph({ root, filesUnder: (dir) => sources.filter((f) => f.startsWith(dir + path.sep)) });
    const c = graph.closure(path.join(root, 'packages/app/test/a.test.ts'));
    expect(c.packages).toEqual(['@m/lib']);
    expect(rel(root, c.files)).toEqual(['packages/app/test/a.test.ts', 'packages/lib/src/impl.ts', 'packages/lib/src/index.ts']);
  });

  it('hashes the same closure the same at another path, so a cache moves between checkouts', () => {
    const files = { 'test/a.test.ts': "import '../src/a';\n", 'src/a.ts': 'export const a = 1;\n' };
    const one = project(files);
    const two = project(files);
    const hash = (root: string) => new ImportGraph({ root }).closureHash(path.join(root, 'test/a.test.ts'));
    expect(hash(one)).toBe(hash(two));
  });

  it('ignores third-party packages and marks a computed import as unknowable', () => {
    const root = project({
      'test/a.test.ts': "import 'lodash';\nconst m = await import(`../src/${name}.js`);\n",
    });
    const c = new ImportGraph().closure(path.join(root, 'test/a.test.ts'));
    expect(c.dynamic).toBe(true);
    expect(c.packages).toEqual([]);
    expect(rel(root, c.files)).toEqual(['test/a.test.ts']);
  });

  it('resolves tsconfig path aliases', () => {
    const root = project({
      'test/a.test.ts': "import { x } from '@/lib/x';\n",
      'src/lib/x.ts': 'export const x = 1;\n',
    });
    const graph = new ImportGraph({ paths: new Map([['@/*', [path.join(root, 'src/*')]]]) });
    expect(rel(root, graph.closure(path.join(root, 'test/a.test.ts')).files)).toEqual(['src/lib/x.ts', 'test/a.test.ts']);
  });

  it('keys the hash on content: an edit changes it, an untouched closure keeps it', () => {
    const root = project({ 'test/a.test.ts': "import '../src/a';\n", 'src/a.ts': 'export const a = 1;\n', 'src/other.ts': '' });
    const test = path.join(root, 'test/a.test.ts');
    const h1 = new ImportGraph().closureHash(test);
    writeFileSync(path.join(root, 'src/other.ts'), 'export const o = 2;\n');
    expect(new ImportGraph().closureHash(test)).toBe(h1);
    writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
    expect(new ImportGraph().closureHash(test)).not.toBe(h1);
  });
});

describe('mayHoldState', () => {
  const holds = (code: string) => mayHoldState(parseSync('m.ts', code).program as never);

  it('is false for modules that only declare', () => {
    for (const code of [
      "import x from 'y';\nexport function f() { return 1; }",
      'export const A = 1, B = "s", C = `t`, D = -1, E = A + 1, F = A ? B : C, G = () => 1, H = function () {};',
      'export interface I { a: number }\ntype T = string;\nenum E { A }\ndeclare let d: number;',
      'export class K { static readonly x: number; m() {} }\nexport default function () {}',
      "'use strict';\ndescribe('x', () => {});\nit('y', () => {});\nvi.mock('./z');",
      "export * from './a';\nexport { b } from './b';\nexport const R = /a/i;",
    ]) {
      expect(holds(code), code).toBe(false);
    }
  });

  it('is true for anything a call could mutate or a load could run', () => {
    for (const code of [
      'let n = 0;',
      'export var cache;',
      'export const m = new Map();',
      'const o = {};',
      'const g = /a/g;',
      'export class K { static count = 0; }',
      'class K { static { init(); } }',
      'register(plugin);',
      'export default new Store();',
      'if (x) {}',
    ]) {
      expect(holds(code), code).toBe(true);
    }
  });
});
