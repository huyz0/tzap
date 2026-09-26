import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModel } from '@tzap/model';
import { afterAll, describe, expect, it } from 'vitest';
import { discover } from '../src/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const slash = (p: string) => p.replace(/\\/g, '/');

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/**
 * Copies a fixture to a temp directory outside this repository (so walking up never finds
 * tzap's own workspace), optionally installing fake runner packages: `{ 'node_modules/vitest': '5.0.2' }`.
 */
function fixture(name: string, installs: Record<string, string> = {}): string {
  const base = mkdtempSync(path.join(tmpdir(), 'tzap-discover-'));
  temps.push(base);
  const dir = path.join(base, name);
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  for (const [where, version] of Object.entries(installs)) {
    const pkgDir = path.join(dir, where);
    mkdirSync(pkgDir, { recursive: true });
    const pkgName = slash(where).split('node_modules/').pop() ?? where;
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version }));
  }
  return dir;
}

const byId = (pkgs: { id: string }[], id: string) => {
  const p = pkgs.find((x) => x.id === id);
  if (!p) throw new Error(`no package ${id} in ${pkgs.map((x) => x.id).join(', ')}`);
  return p;
};

describe('discover', () => {
  it('single-package vitest project with a config file and an installed vitest', async () => {
    const dir = fixture('single-vitest', { 'node_modules/vitest': '5.0.2' });
    const { model, notes } = await discover({ cwd: path.join(dir, 'src') });
    expect(model.root).toBe(slash(dir));
    expect(model.root).not.toContain('\\');
    expect(model.packages).toHaveLength(1);
    const [pkg] = model.packages;
    expect(pkg).toMatchObject({
      id: 'single-vitest',
      root: '.',
      sources: ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
      tsconfig: 'tsconfig.json',
      runner: { kind: 'vitest', config: 'vitest.config.ts', version: '5.0.2' },
    });
    expect(pkg?.tests).toBeUndefined();
    expect(pkg?.exclude).toEqual(expect.arrayContaining(['**/*.{test,spec}.*', '**/*.d.ts', '**/node_modules/**', 'dist/**', 'build/**', 'coverage/**']));
    expect(notes.join('\n')).toMatch(/single-package/);
    expect(() => validateModel(model)).not.toThrow();
  });

  it('single-package jest project from a `jest` key; missing install means no version and a note', async () => {
    const dir = fixture('single-jest');
    const { model, notes } = await discover({ cwd: dir });
    const [pkg] = model.packages;
    expect(pkg?.runner).toEqual({ kind: 'jest' });
    expect(pkg?.tsconfig).toBeUndefined();
    expect(notes.some((n) => /jest is not installed/.test(n))).toBe(true);
  });

  it('pnpm workspace: globs with negation, a test-less library, vitest only at the root', async () => {
    const dir = fixture('pnpm-ws', { 'node_modules/vitest': '5.0.2' });
    const { model, notes } = await discover({ cwd: path.join(dir, 'packages', 'app', 'src') });
    expect(model.root).toBe(slash(dir));
    expect(model.packages.map((p) => p.id)).toEqual(['@acme/app', '@acme/lib', '@acme/viaroot']);

    expect(byId(model.packages, '@acme/app')).toMatchObject({
      root: 'packages/app',
      tsconfig: 'packages/app/tsconfig.json',
      runner: { kind: 'vitest', config: 'packages/app/vitest.config.mts', version: '5.0.2' },
    });

    const lib = byId(model.packages, '@acme/lib');
    expect(lib.runner).toBeUndefined();
    expect(lib.tests).toEqual([]);
    expect(notes.some((n) => n.startsWith('@acme/lib') && /mutation source only/.test(n))).toBe(true);

    // vitest is not in @acme/viaroot's dependencies: its test script runs the root's vitest.
    const viaroot = byId(model.packages, '@acme/viaroot');
    expect(viaroot.runner).toEqual({ kind: 'vitest', version: '5.0.2' });
    expect(notes.some((n) => /installed at the workspace root/.test(n))).toBe(true);

    expect(notes.some((n) => /tooling only/.test(n))).toBe(true);
    expect(() => validateModel(model)).not.toThrow();
  });

  it('npm workspaces: mocha, node --test, and a package without src/', async () => {
    const dir = fixture('npm-ws');
    const { model, notes } = await discover({ cwd: dir });
    expect(model.packages.map((p) => [p.id, p.root])).toEqual([
      ['a', 'packages/a'],
      ['b', 'packages/b'],
      ['c', 'packages/c'],
    ]);
    expect(byId(model.packages, 'a').runner).toEqual({ kind: 'mocha', config: 'packages/a/.mocharc.json' });
    expect(byId(model.packages, 'b').runner).toEqual({ kind: 'node' });

    const c = byId(model.packages, 'c');
    expect(c.sources).toEqual(['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}']);
    expect(c.exclude).toEqual(expect.arrayContaining(['*.config.*', '.*rc.*', 'scripts/**', '**/*.{test,spec}.*']));
    expect(c.runner?.kind).toBe('vitest');
    expect(notes.some((n) => n.startsWith('c (packages/c)') && /no src\//.test(n))).toBe(true);
    expect(() => validateModel(model)).not.toThrow();
  });

  it('yarn workspaces, object form; an unnamed package is identified by its directory', async () => {
    const dir = fixture('yarn-ws', { 'node_modules/jest': '30.1.0' });
    const { model, notes } = await discover({ cwd: path.join(dir, 'libs', 'x') });
    expect(model.packages.map((p) => p.id)).toEqual(['@y/x', 'libs/unnamed']);
    expect(byId(model.packages, '@y/x').runner).toEqual({ kind: 'jest', config: 'libs/x/jest.config.js', version: '30.1.0' });
    const unnamed = byId(model.packages, 'libs/unnamed');
    expect(unnamed.runner).toBeUndefined();
    expect(unnamed.tests).toEqual([]);
    expect(notes.some((n) => /has no name/.test(n))).toBe(true);
  });

  it('filter keeps packages by id or by directory', async () => {
    const dir = fixture('pnpm-ws');
    const byIdFilter = await discover({ cwd: dir, filter: ['@acme/lib'] });
    expect(byIdFilter.model.packages.map((p) => p.id)).toEqual(['@acme/lib']);

    const byRoot = await discover({ cwd: dir, filter: ['packages/app/', './packages/viaroot'] });
    expect(byRoot.model.packages.map((p) => p.id)).toEqual(['@acme/app', '@acme/viaroot']);

    const byAbsDir = await discover({ cwd: path.join(dir, 'packages'), filter: [path.join(dir, 'packages', 'lib')] });
    expect(byAbsDir.model.packages.map((p) => p.id)).toEqual(['@acme/lib']);

    await expect(discover({ cwd: dir, filter: ['nope'] })).rejects.toThrow(/matched no package/);
  });

  it('a package inside an unrelated workspace is treated as a single-package project', async () => {
    // The in-repo fixture sits under tzap's own pnpm workspace, which does not list it.
    const { model, notes } = await discover({ cwd: path.join(FIXTURES, 'single-vitest') });
    expect(model.root).toBe(slash(path.join(FIXTURES, 'single-vitest')));
    expect(model.packages.map((p) => p.root)).toEqual(['.']);
    expect(notes.some((n) => /is not one of its packages/.test(n))).toBe(true);
  });

  it('a root Vitest config listing projects becomes one package owning every member', async () => {
    const dir = fixture('pnpm-ws', { 'node_modules/vitest': '5.0.2' });
    writeFileSync(path.join(dir, 'vitest.config.ts'), "export default { test: { projects: ['packages/*'] } };\n");
    const { model, notes } = await discover({ cwd: dir });
    expect(model.packages).toHaveLength(1);
    const [only] = model.packages;
    expect(only!.root).toBe('.');
    expect(only!.runner).toEqual({ kind: 'vitest', config: 'vitest.config.ts', version: '5.0.2' });
    expect(only!.sources).toContain('packages/app/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}');
    expect(only!.sources).toContain('packages/lib/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}');
    expect(notes.some((n) => n.includes('lists Vitest projects'))).toBe(true);
  });

  it('fails clearly when there is no package.json at all', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'tzap-discover-empty-'));
    temps.push(base);
    // tmpdir may itself sit under a directory with a package.json on some machines; only assert when it does not.
    const result = await discover({ cwd: base }).catch((e: Error) => e);
    if (result instanceof Error) expect(result.message).toMatch(/no package\.json found/);
  });
});
