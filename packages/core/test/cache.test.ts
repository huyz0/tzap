import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisResult, MutantDescriptor, MutantResult, ProjectModel } from '@tzap/model';
import { loadCache, saveCache, type CacheSettings } from '../src/cache.js';
import type { MutantCoverage } from '../src/engine.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A one-package project on disk (the fingerprint reads it) and a cache directory beside it. */
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'tzap-cache-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
  const model: ProjectModel = { schemaVersion: 1, root, packages: [{ id: 'p', root: '.', sources: ['src/**/*.ts'], runner: { kind: 'vitest' } }] };
  return { root, model, dir: path.join(root, '.tzap-cache') };
}
const settings: CacheSettings = { tzapVersion: 't', mutators: undefined, filters: [] };

const mutant = (id: string, extra: Partial<MutantDescriptor> = {}): MutantDescriptor => ({
  id,
  num: 0,
  file: 'src/a.ts',
  mutatorName: 'BooleanLiteral',
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  replacement: 'false',
  original: 'true',
  site: 0,
  ...extra,
});
const result = (mutants: MutantResult[], extra: Partial<AnalysisResult> = {}): AnalysisResult => ({
  tzapVersion: 't',
  root: '.',
  files: {},
  mutants,
  tests: [
    { id: 'p::t1', name: 't1', file: 'test/a.test.ts', closure: 'c1' },
    { id: 'p::t2', name: 't2', file: 'test/b.test.ts', closure: 'c2' },
  ],
  redTests: [],
  config: { engine: 'warm', typecheck: 'off', mutators: [], filters: [], scope: 'full' },
  timings: {},
  ...extra,
});
const coverage = (tests: string[], closures: Record<string, string> = { 'p::t1': 'c1', 'p::t2': 'c2' }, staticRan?: string[]): MutantCoverage => ({
  static: staticRan !== undefined,
  tests,
  closures: new Map(Object.entries(closures)),
  ...(staticRan ? { ran: staticRan } : {}),
});

describe('the cache', () => {
  it('reuses a kill while the killing test still reaches the mutant and nothing it reaches changed', () => {
    const { model, dir } = setup();
    saveCache(loadCache(dir, model, settings), result([{ ...mutant('m'), status: 'Killed', killedBy: ['p::t1'], coveredBy: ['p::t1', 'p::t2'] }]));
    const c = loadCache(dir, model, settings);
    expect(c.reuse(mutant('m'), coverage(['p::t1']))?.status).toBe('Killed');
    expect(c.reuse(mutant('m'), coverage(['p::t2']))).toBeUndefined(); // the killer no longer reaches it
    expect(c.reuse(mutant('m'), coverage(['p::t1'], { 'p::t1': 'changed' }))).toBeUndefined();
    expect(c.killers.get('m')).toBe('p::t1');
  });

  it('reuses a survivor only while exactly the same tests reach it, all unchanged', () => {
    const { model, dir } = setup();
    saveCache(loadCache(dir, model, settings), result([{ ...mutant('m'), status: 'Survived', coveredBy: ['p::t1', 'p::t2'] }]));
    const c = loadCache(dir, model, settings);
    expect(c.reuse(mutant('m'), coverage(['p::t2', 'p::t1']))?.status).toBe('Survived');
    expect(c.reuse(mutant('m'), coverage(['p::t1']))).toBeUndefined(); // a test stopped reaching it
    expect(c.reuse(mutant('m'), coverage(['p::t1', 'p::t2'], { 'p::t1': 'c1', 'p::t2': 'x' }))).toBeUndefined();
  });

  it('reuses a static mutant, however it was killed, while the files that decide it are unchanged', () => {
    const { model, dir } = setup();
    const ran = ['p::t1', 'p::t2'];
    saveCache(
      loadCache(dir, model, settings),
      result([
        // Killed by a test file that failed to load: no test is named.
        { ...mutant('load'), status: 'Killed', static: true, killedBy: ['p::test/a.test.ts'], coveredBy: ran },
        { ...mutant('unhandled'), status: 'Killed', static: true, killedBy: ['p::unhandled error'], coveredBy: ran },
        { ...mutant('lives'), status: 'Survived', static: true, coveredBy: ran },
      ]),
    );
    const c = loadCache(dir, model, settings);
    for (const id of ['load', 'unhandled', 'lives']) {
      expect(c.reuse(mutant(id), coverage([], undefined, ran)), id).toBeDefined();
      expect(c.reuse(mutant(id), coverage([], undefined, ['p::t1'])), id).toBeUndefined();
      expect(c.reuse(mutant(id), coverage([], { 'p::t1': 'c1', 'p::t2': 'edited' }, ran)), id).toBeUndefined();
      // No longer static: decided by other means now.
      expect(c.reuse(mutant(id), coverage(ran)), id).toBeUndefined();
    }
  });

  it('never reuses a RuntimeError or a wall-clock timeout', () => {
    const { model, dir } = setup();
    saveCache(
      loadCache(dir, model, settings),
      result([
        { ...mutant('rt'), status: 'RuntimeError' },
        { ...mutant('wall'), status: 'Timeout', statusReason: 'wall-clock backstop', killedBy: ['p::t1'] },
      ]),
    );
    const c = loadCache(dir, model, settings);
    expect(c.reuse(mutant('rt'), coverage(['p::t1']))).toBeUndefined();
    expect(c.reuse(mutant('wall'), coverage(['p::t1']))).toBeUndefined();
  });

  it('answers everything when nothing changed, red tests included, and nothing once a file changes', () => {
    const { root, model, dir } = setup();
    const red = [{ id: 'p::t3', name: 't3', file: 'test/c.test.ts', message: 'boom' }];
    saveCache(loadCache(dir, model, settings), result([{ ...mutant('m'), status: 'Survived', coveredBy: ['p::t1'] }], { redTests: red }));
    const same = loadCache(dir, model, settings);
    expect(same.unchanged).toBe(true);
    expect(same.lookupUnchanged!.lookup(mutant('m'))?.status).toBe('Survived');
    expect(same.lookupUnchanged!.tests.map((t) => t.id)).toEqual(['p::t1', 'p::t2']);
    expect(same.lookupUnchanged!.red).toEqual(red);
    writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
    const edited = loadCache(dir, model, settings);
    expect(edited.unchanged).toBe(false);
    expect(edited.lookupUnchanged).toBeUndefined();
  });

  it('is rewritten whole by a full run, and updated in part by a diff run', () => {
    const { model, dir } = setup();
    saveCache(loadCache(dir, model, settings), result([{ ...mutant('gone'), status: 'Survived' }, { ...mutant('kept'), status: 'Survived' }]));
    // A full run in which test t2 was renamed and mutant "gone" deleted.
    const renamed = [{ id: 'p::t1', name: 't1', file: 'test/a.test.ts', closure: 'c1' }, { id: 'p::t2b', name: 't2b', file: 'test/b.test.ts', closure: 'c2' }];
    saveCache(loadCache(dir, model, settings), result([{ ...mutant('kept'), status: 'Killed', killedBy: ['p::t1'] }], { tests: renamed }));
    let c = loadCache(dir, model, settings);
    expect([...c.tests.keys()].sort()).toEqual(['p::t1', 'p::t2b']);
    expect([...c.entries.keys()]).toEqual(['kept']);
    // A diff run that decides one new mutant keeps everything else.
    saveCache(c, result([{ ...mutant('new'), status: 'Survived' }], { tests: [renamed[0]!], config: { ...result([]).config, scope: 'diff' } }));
    c = loadCache(dir, model, settings);
    expect([...c.entries.keys()].sort()).toEqual(['kept', 'new']);
    expect([...c.tests.keys()].sort()).toEqual(['p::t1', 'p::t2b']);
  });

  it('is ignored, with a note, under settings that can change a verdict', () => {
    const { model, dir } = setup();
    saveCache(loadCache(dir, model, settings), result([{ ...mutant('m'), status: 'Survived' }]));
    for (const other of [{ typecheck: 'survivors' }, { verifySurvivors: 'off' }, { tzapVersion: 'u' }, { filters: ['arid'] }, { mutators: ['BooleanLiteral'] }]) {
      const c = loadCache(dir, model, { ...settings, ...other });
      expect(c.entries.size, JSON.stringify(other)).toBe(0);
      expect(c.unchanged).toBe(false);
      expect(c.note).toMatch(/different toolchain/);
    }
  });

  it('ignores a damaged file entirely, not just from the damage on', () => {
    const { model, dir } = setup();
    saveCache(loadCache(dir, model, settings), result([{ ...mutant('m'), status: 'Survived' }]));
    const file = path.join(dir, 'tzap-cache.txt');
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, `${text}zz\t{not json\n`);
    const c = loadCache(dir, model, settings);
    expect(c.note).toMatch(/could not be read and is ignored/);
    expect(c.entries.size).toBe(0);
    expect(c.unchanged).toBe(false);
    // A file that is not a tzap cache at all.
    writeFileSync(file, 'hello\n');
    expect(loadCache(dir, model, settings).note).toMatch(/not a tzap cache/);
    // No cache yet is not worth a note.
    rmSync(dir, { recursive: true });
    expect(loadCache(dir, model, settings).note).toBeUndefined();
  });
});
