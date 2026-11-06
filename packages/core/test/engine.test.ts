import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instrument } from '@tzap/instrument';
import { MODEL_SCHEMA_VERSION, type AnalysisResult, type MutantDescriptor, type ProjectModel } from '@tzap/model';
import { analyse, type EngineEvent, type EngineOptions } from '../src/index.js';
import { fakeRunner, type Script } from './fake-runner.js';

// Four functions, one arithmetic mutant each: mutant n sits in function n (add, sub, mul, div).
const SOURCE = ['export const add = (a, b) => a + b;', 'export const sub = (a, b) => a - b;', 'export const mul = (a, b) => a * b;', 'export const div = (a, b) => a / b;', ''].join('\n');
const MUTATORS = ['ArithmeticOperator'];

let root: string;
let mutants: MutantDescriptor[];
/** Mutant number and site by function. */
const at = (fn: 'add' | 'sub' | 'mul' | 'div') => mutants[['add', 'sub', 'mul', 'div'].indexOf(fn)]!;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tzap-engine-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'test'));
  writeFileSync(path.join(root, 'src/math.js'), SOURCE);
  for (const f of ['a', 'b', 'c']) writeFileSync(path.join(root, `test/${f}.test.js`), `import * as m from '../src/math.js';\n`);
  // test/s reaches module state: a registry a warm run of its tests can leave filled.
  writeFileSync(path.join(root, 'test/registry.js'), 'export const registry = new Map();\n');
  writeFileSync(path.join(root, 'test/s.test.js'), `import * as m from '../src/math.js';\nimport { registry } from './registry.js';\n`);
  mutants = instrument({ file: 'src/math.js', source: SOURCE, mutators: MUTATORS, firstMutant: 0, firstSite: 0 }).mutants;
  expect(mutants.map((m) => m.original)).toEqual(['a + b', 'a - b', 'a * b', 'a / b']);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const model = (): ProjectModel => ({
  schemaVersion: MODEL_SCHEMA_VERSION,
  root,
  packages: [{ id: 'pkg', root: '.', sources: ['src/**/*.js'], tests: ['test/**/*.test.js'], runner: { kind: 'vitest' } }],
});

async function run(script: Script, options: Partial<EngineOptions> = {}) {
  const { factory, log } = fakeRunner(script);
  const events: EngineEvent[] = [];
  const result = await analyse(model(), { runners: { vitest: factory }, mutators: MUTATORS, tzapVersion: 'test', verifySurvivors: false, onEvent: (e) => events.push(e), ...options });
  const verdict = (fn: Parameters<typeof at>[0]) => result.mutants.find((m) => m.num === at(fn).num)!;
  return { result, log, events, verdict };
}

/** The tests the isolated runs tried a mutant against, in the order first planned. */
const isolatedPlan = (log: { runs: Array<{ mode: string; plan?: Record<string, Array<{ m: number }>> }> }, m: number) => [
  ...new Set(log.runs.filter((r) => r.mode === 'static').flatMap((r) => Object.entries(r.plan ?? {}).filter(([, l]) => l.some((t) => t.m === m)).map(([id]) => id))),
];

const statuses = (r: AnalysisResult) => Object.fromEntries(r.mutants.map((m) => [m.original, m.status]));

describe('the warm engine', () => {
  const tests = () => [
    { id: 'a1', file: 'test/a.test.js', hits: [at('add').site, at('sub').site] },
    { id: 'b1', file: 'test/b.test.js', hits: [at('add').site, at('sub').site, at('mul').site] },
  ];

  it('credits the killing test, keeps survivors and leaves unreached code uncovered', async () => {
    const { result, verdict } = await run({ tests: tests(), outcome: (t, m) => (m === at('sub').num && t === 'b1' ? 'K' : 'S') });
    expect(statuses(result)).toEqual({ 'a + b': 'Survived', 'a - b': 'Killed', 'a * b': 'Survived', 'a / b': 'NoCoverage' });
    expect(verdict('sub').killedBy).toEqual(['pkg::b1']);
    expect(verdict('sub').statusReason).toBe(`b1 failed with ${at('sub').num}`);
    expect(verdict('add').coveredBy).toEqual(['pkg::a1', 'pkg::b1']);
  });

  it('tries the previous killer first', async () => {
    const { log } = await run({ tests: tests(), outcome: () => 'K' }, { previousKillers: new Map([[at('add').id, 'pkg::b1']]) });
    const first = log.runs.find((r) => r.mode === 'mutate')!;
    expect(first.plan!['b1']!.some((t) => t.m === at('add').num)).toBe(true);
    expect(first.plan!['a1']?.some((t) => t.m === at('add').num) ?? false).toBe(false);
  });

  it('reports a hang the runner caught as Timeout', async () => {
    const { verdict } = await run({ tests: tests(), outcome: (_t, m) => (m === at('mul').num ? 'T' : 'S') });
    expect(verdict('mul').status).toBe('Timeout');
  });

  it('does not trust tries whose bracketing control failed, and decides them behind a control of their own', async () => {
    // add leaves state behind that fails the next unmutated run of the test: in the bracketed
    // round [control, add, sub, control] the closing control fails, so neither try counts.
    const { result, log } = await run({ tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site, at('sub').site] }], corrupts: new Set([at('add').num]), outcome: (_t, m) => (m === at('sub').num ? 'K' : 'S') });
    expect(statuses(result)).toMatchObject({ 'a + b': 'Survived', 'a - b': 'Killed' });
    // Behind its own control, add's try counts; sub's does not yet, as the control before it ran
    // after add. Alone, it does.
    const [add, sub] = [at('add').num, at('sub').num];
    expect(log.runs.filter((r) => r.mode === 'mutate').map((r) => r.plan!['a1']!.map((t) => t.m))).toEqual([
      [-1, add, sub, -1],
      [-1, add, -1, sub, -1],
      [-1, sub, -1],
    ]);
  });

  it('retries the tries a runner skipped for a kill that did not count', async () => {
    // Round 2 tries add then sub in b1, and sub in c1. add leaves state behind; sub, tried after
    // it, fails in b1 because of that state, so the runner skips sub in c1 as already killed. b1's
    // closing control fails, the kill does not count, and sub must still be tried against c1.
    const [add, sub] = [at('add').num, at('sub').num];
    let falseKill = true;
    const { verdict, log } = await run({
      tests: [
        { id: 'a1', file: 'test/a.test.js', hits: [at('add').site, at('sub').site] },
        { id: 'b1', file: 'test/a.test.js', hits: [at('add').site, at('sub').site] },
        { id: 'c1', file: 'test/a.test.js', hits: [at('sub').site] },
      ],
      corrupts: new Set([add]),
      outcome: (t, m) => {
        if (t === 'b1' && m === sub && falseKill) {
          falseKill = false;
          return 'K';
        }
        return 'S';
      },
    });
    const rounds = log.runs.filter((r) => r.mode === 'mutate').map((r) => r.plan!);
    expect(rounds[1]!['c1']!.map((t) => t.m)).toEqual([-1, sub, -1]);
    expect(rounds.slice(2).some((p) => p['c1']?.some((t) => t.m === sub))).toBe(true);
    expect(verdict('sub')).toMatchObject({ status: 'Survived', coveredBy: ['pkg::a1', 'pkg::b1', 'pkg::c1'] });
  });

  it('decides in isolation what state broken for good keeps from being trusted', async () => {
    // add breaks a1 for the rest of the session: no round behind controls makes progress.
    const { verdict, events } = await run({
      tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site, at('sub').site] }],
      poisons: new Set([at('add').num]),
      outcome: (_t, m, mode) => (m === at('sub').num && mode === 'static' ? 'K' : 'S'),
    });
    expect(verdict('sub')).toMatchObject({ status: 'Killed', killedBy: ['pkg::a1'] });
    expect(verdict('add').status).toBe('Survived');
    expect(events).toContainEqual({ type: 'warning', message: '2 mutants re-decided in isolation: never reached in the warm run, or covered by tests whose warm runs could not be trusted' });
  });

  it('sends a mutant to isolation when a trusted try never reached it', async () => {
    const { verdict, log } = await run({ tests: tests(), outcome: (t, m) => (m === at('add').num ? (t === 'a1' ? 'U' : 'S') : 'S') });
    expect(verdict('add').status).toBe('Survived');
    expect(log.runs.some((r) => r.mode === 'static' && Object.values(r.plan ?? {}).some((l) => l[0]!.m === at('add').num))).toBe(true);
  });

  it('confirms survivors in isolation when asked to, and says so', async () => {
    const { events, log } = await run({ tests: tests() }, { verifySurvivors: true });
    expect(events).toContainEqual({ type: 'info', message: 'confirming 3 warm survivors in isolation' });
    expect(log.sessions.some((s) => s.isolate)).toBe(true);
  });

  describe('confirming a warm survivor', () => {
    // add is covered by a1, whose file reaches no module state, and s1, whose file does.
    const mixed = (s: Partial<Script> = {}): Script => ({
      tests: [
        { id: 'a1', file: 'test/a.test.js', hits: [at('add').site] },
        { id: 's1', file: 'test/s.test.js', hits: [at('add').site] },
      ],
      ...s,
    });

    it('re-runs every covering test when one can reach module state (auto)', async () => {
      const { verdict, log, events } = await run(mixed(), { verifySurvivors: 'auto' });
      expect(events).toContainEqual({ type: 'info', message: 'confirming 1 warm survivors in isolation' });
      expect(isolatedPlan(log, at('add').num).sort()).toEqual(['a1', 's1']);
      expect(verdict('add')).toMatchObject({ status: 'Survived', coveredBy: ['pkg::a1', 'pkg::s1'], testsCompleted: 2 });
    });

    it('keeps a kill the isolated run finds: a warm survival masked by state', async () => {
      const { verdict } = await run(mixed({ outcome: (t, m, mode) => (t === 's1' && m === at('add').num && mode === 'static' ? 'K' : 'S') }), { verifySurvivors: 'auto' });
      expect(verdict('add')).toMatchObject({ status: 'Killed', killedBy: ['pkg::s1'], coveredBy: ['pkg::a1', 'pkg::s1'] });
    });

    it('re-runs every covering test when asked to verify all survivors', async () => {
      const { log, verdict } = await run({ tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site] }, { id: 'b1', file: 'test/b.test.js', hits: [at('add').site] }] }, { verifySurvivors: true });
      expect(isolatedPlan(log, at('add').num).sort()).toEqual(['a1', 'b1']);
      expect(verdict('add').status).toBe('Survived');
    });

    it('with verification off, runs in isolation only the tests the warm engine could not try', async () => {
      // 0.1.1 re-ran every covering test here: --verify-survivors off still paid for a full confirmation.
      const script = mixed({
        tests: [
          { id: 'a1', file: 'test/a.test.js', hits: [at('add').site] },
          { id: 's1', file: 'test/s.test.js', hits: [at('add').site] },
          { id: 'b1', file: 'test/b.test.js', hits: [at('add').site], stateSensitive: 'fails when repeated' },
        ],
      });
      const quiet = await run(script, { verifySurvivors: false });
      expect(isolatedPlan(quiet.log, at('add').num)).toEqual(['b1']);
      // The run loads only the file it needs.
      expect(quiet.log.runs.filter((r) => r.mode === 'static').flatMap((r) => r.files!.map((f) => path.basename(f)))).toEqual(['b.test.js']);
      expect(quiet.verdict('add')).toMatchObject({ status: 'Survived', coveredBy: ['pkg::a1', 'pkg::b1', 'pkg::s1'], testsCompleted: 3 });
      // The test it could not try still decides: a kill there is a kill.
      const killed = await run({ ...script, outcome: (t, m, mode) => (t === 'b1' && m === at('add').num && mode === 'static' ? 'K' : 'S') }, { verifySurvivors: false });
      expect(killed.verdict('add')).toMatchObject({ status: 'Killed', killedBy: ['pkg::b1'] });
    });

    it('needs no isolated run when every covering test was tried warm and none reaches state (auto)', async () => {
      const { log, verdict } = await run({ tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site] }] }, { verifySurvivors: 'auto' });
      expect(log.runs.some((r) => r.mode === 'static')).toBe(false);
      expect(verdict('add').status).toBe('Survived');
    });
  });

  it('decides mutants only state-sensitive tests cover in isolation', async () => {
    const { verdict, events } = await run({
      tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site], stateSensitive: 'fails when repeated' }],
      outcome: (_t, m, mode) => (m === at('add').num && mode === 'static' ? 'K' : 'S'),
    });
    expect(verdict('add').status).toBe('Killed');
    expect(events.some((e) => e.type === 'warning' && e.message.startsWith('1 of 1 tests behave differently when repeated'))).toBe(true);
  });

  it('declares a mutant that stalls the run hung, restarts the session and decides the rest', async () => {
    const { result, log, events } = await run({ tests: tests(), outcome: (t, m) => (m === at('add').num ? 'hang' : m === at('sub').num && t === 'b1' ? 'K' : 'S') });
    expect(statuses(result)).toMatchObject({ 'a + b': 'Timeout', 'a - b': 'Killed', 'a * b': 'Survived' });
    expect(result.mutants.find((m) => m.original === 'a + b')!.statusReason).toBe('wall-clock backstop');
    expect(log.sessions.length).toBeGreaterThan(1);
    expect(events).toContainEqual({ type: 'warning', message: `wall-clock backstop: mutants ${at('add').num} declared hung` });
  });

  it('decides in isolation the mutants of a run that stalls with no mutant try in flight', async () => {
    const { result, events } = await run({
      tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site, at('sub').site] }],
      stallsControl: new Set([at('add').num]),
      outcome: (_t, m, mode) => (m === at('add').num && mode === 'static' ? 'K' : 'S'),
    });
    expect(statuses(result)).toMatchObject({ 'a + b': 'Killed', 'a - b': 'Survived' });
    expect(events.some((e) => e.type === 'warning' && /went silent .* no mutant try in flight; its 2 remaining mutants are decided in isolation/.test(e.message))).toBe(true);
  });

  it('decides in isolation the mutants of a round an unhandled error failed', async () => {
    const { result, log } = await run({
      tests: tests(),
      // The error belongs to mul, but a warm round cannot tell whose it is.
      unhandled: (active, mode) => (active.includes(at('mul').num) ? [{ error: `boom from ${mode}` }] : []),
    });
    expect(statuses(result)).toMatchObject({ 'a * b': 'Killed' });
    expect(result.mutants.find((m) => m.original === 'a * b')!.statusReason).toBe('unhandled error during the run: boom from static');
    expect(log.runs.filter((r) => r.mode === 'static').length).toBeGreaterThan(0);
  });

  it('ignores unhandled errors in a package whose suite reports them unmutated', async () => {
    const { result, events } = await run({ tests: tests(), unhandled: () => [{ error: 'always' }] });
    expect(statuses(result)).toMatchObject({ 'a + b': 'Survived', 'a - b': 'Survived', 'a * b': 'Survived' });
    expect(events.some((e) => e.type === 'warning' && e.message.includes('unhandled errors cannot count against mutants there'))).toBe(true);
  });

  it('reports red tests and keeps their mutants from counting them', async () => {
    const { result, verdict } = await run({ tests: [...tests(), { id: 'c1', file: 'test/c.test.js', hits: [at('div').site], red: 'broken' }] });
    expect(result.redTests).toEqual([{ id: 'pkg::c1', name: 'c1', file: 'test/c.test.js', message: 'broken' }]);
    expect(verdict('div').status).toBe('NoCoverage');
  });
});

describe('the isolated path', () => {
  // mul runs while test/a and test/b load (a static mutant); add is reached in a test.
  const staticScript = (s: Partial<Script> = {}): Script => ({
    tests: [
      { id: 'a1', file: 'test/a.test.js', hits: [at('add').site] },
      { id: 'b1', file: 'test/b.test.js', hits: [] },
    ],
    staticHits: { 'test/a.test.js': [at('mul').site], 'test/b.test.js': [at('mul').site, at('div').site] },
    ...s,
  });

  it('never decides a static mutant warm: it runs with the mutant active from the start', async () => {
    const { verdict, log } = await run(staticScript({ outcome: (t, m, mode) => (m === at('mul').num && t === 'b1' && mode === 'static' ? 'K' : 'S') }));
    expect(verdict('mul')).toMatchObject({ status: 'Killed', static: true, killedBy: ['pkg::b1'] });
    expect(log.runs.filter((r) => r.mode === 'mutate').every((r) => Object.values(r.plan!).every((l) => l.every((t) => t.m !== at('mul').num)))).toBe(true);
  });

  it('kills a static mutant that breaks loading, crediting the file', async () => {
    const { verdict } = await run(staticScript({ loadError: (f, m) => (m === at('div').num && f === 'test/b.test.js' ? 'SyntaxError: nope' : undefined) }));
    expect(verdict('div')).toMatchObject({ status: 'Killed', killedBy: ['pkg::test/b.test.js'], statusReason: 'test file failed to load: SyntaxError: nope' });
  });

  it('packs static mutants into one run per file set where the runner allows, and tries the likeliest file first', async () => {
    const { verdict, log } = await run(staticScript({ staticPerFile: true, isolatesFiles: true, outcome: (_t, m) => (m === at('mul').num ? 'K' : 'S') }));
    expect(verdict('mul').status).toBe('Killed');
    expect(verdict('div').status).toBe('Survived');
    const first = log.runs.find((r) => r.mode === 'static')!;
    // One run activates mul in one file and div in the other.
    expect(Object.values(first.staticPlan!).sort()).toEqual([at('mul').num, at('div').num].sort());
  });

  describe('a static mutant that survives its first file', () => {
    // mul runs while every file loads. a1 and s1 call into math.js at runtime (they reach add);
    // b1 and c1 only load it.
    const spread = (s: Partial<Script> = {}): Script => ({
      tests: [
        { id: 'a1', file: 'test/a.test.js', hits: [at('add').site] },
        { id: 's1', file: 'test/s.test.js', hits: [at('add').site] },
        { id: 'b1', file: 'test/b.test.js', hits: [] },
        { id: 'c1', file: 'test/c.test.js', hits: [] },
      ],
      staticHits: { 'test/a.test.js': [at('mul').site], 'test/s.test.js': [at('mul').site], 'test/b.test.js': [at('mul').site], 'test/c.test.js': [at('mul').site] },
      staticPerFile: true,
      isolatesFiles: true,
      ...s,
    });
    /** The files each static run loaded with mul active, run by run. */
    const mulRuns = (log: { runs: Array<{ mode: string; files?: string[]; staticPlan?: Record<string, number> }> }) =>
      log.runs
        .filter((r) => r.mode === 'static')
        .map((r) => Object.entries(r.staticPlan ?? {}).filter(([, m]) => m === at('mul').num).map(([f]) => path.basename(f)).sort())
        .filter((fs) => fs.length > 0);

    it('is tried next in the files whose tests call into its module, and stops there when they kill it', async () => {
      const { verdict, log } = await run(spread({ outcome: (t, m, mode) => (t === 's1' && m === at('mul').num && mode === 'static' ? 'K' : 'S') }));
      expect(verdict('mul')).toMatchObject({ status: 'Killed', killedBy: ['pkg::s1'], static: true });
      expect(mulRuns(log)).toEqual([['a.test.js'], ['s.test.js']]);
    });

    it('survives only once every file that loads it has run with it active', async () => {
      const { verdict, log, events } = await run(spread());
      expect(mulRuns(log)).toEqual([['a.test.js'], ['s.test.js'], ['b.test.js', 'c.test.js']]);
      expect(events).toContainEqual({ type: 'info', message: 'static mutants, wave 2: 1 not killed yet, 2 test file runs' });
      expect(verdict('mul')).toMatchObject({ status: 'Survived', coveredBy: ['pkg::a1', 'pkg::b1', 'pkg::c1', 'pkg::s1'] });
    });

    it('goes through the files that call into its module in growing waves, those reaching most of it first', async () => {
      // Ten more files call into math.js: m0 reaches add, sub and div; the others add only.
      const callers = Array.from({ length: 10 }, (_, i) => `m${i}`);
      for (const id of callers) writeFileSync(path.join(root, `test/${id}.test.js`), `import * as m from '../src/math.js';\n`);
      const script = spread();
      script.tests.push(...callers.map((id) => ({ id, file: `test/${id}.test.js`, hits: id === 'm0' ? [at('add').site, at('sub').site, at('div').site] : [at('add').site] })));
      for (const id of callers) script.staticHits![`test/${id}.test.js`] = [at('mul').site];
      const { log } = await run(script);
      const waves = mulRuns(log);
      // m0 reaches most of math.js: it is the first pass, alone. Then eight of the other eleven
      // files that call in, the last three, and the two that only load the module.
      expect(waves.map((w) => w.length)).toEqual([1, 8, 3, 2]);
      expect(waves[0]).toEqual(['m0.test.js']);
      expect(waves[3]).toEqual(['b.test.js', 'c.test.js']);
      expect(waves.flat().sort()).toEqual(['a.test.js', 'b.test.js', 'c.test.js', ...callers.map((id) => `${id}.test.js`), 's.test.js'].sort());
    });

    it('is tried first in the test file named for its module, even when other static mutants are tried there too', async () => {
      // math.test.js is named for src/math.js. Two static mutants, mul and div, load in a, b and
      // math; only math's test kills them. Spreading the mutants over unused files would give one
      // of them a, a far weaker first try.
      writeFileSync(path.join(root, 'test/math.test.js'), `import * as m from '../src/math.js';\n`);
      const script: Script = {
        tests: [
          { id: 'a1', file: 'test/a.test.js', hits: [at('add').site] },
          { id: 'b1', file: 'test/b.test.js', hits: [at('add').site] },
          { id: 't1', file: 'test/math.test.js', hits: [] },
        ],
        staticHits: {
          'test/a.test.js': [at('mul').site, at('div').site],
          'test/b.test.js': [at('mul').site, at('div').site],
          'test/math.test.js': [at('mul').site, at('div').site],
        },
        staticPerFile: true,
        isolatesFiles: true,
        outcome: (t, m, mode) => (t === 't1' && mode === 'static' && (m === at('mul').num || m === at('div').num) ? 'K' : 'S'),
      };
      const { verdict, log } = await run(script);
      expect(verdict('mul')).toMatchObject({ status: 'Killed', killedBy: ['pkg::t1'] });
      expect(verdict('div')).toMatchObject({ status: 'Killed', killedBy: ['pkg::t1'] });
      // Each was first tried in math.test.js, and never needed another file.
      const files = (m: number) =>
        log.runs.filter((r) => r.mode === 'static').flatMap((r) => Object.entries(r.staticPlan ?? {}).filter(([, n]) => n === m).map(([f]) => path.basename(f)));
      expect(files(at('mul').num)).toEqual(['math.test.js']);
      expect(files(at('div').num)).toEqual(['math.test.js']);
    });

    it('is tried first in the test file named for its module when other files reach it too', async () => {
      // mul and div run while a, b and math load, and the tests of all three call them too. Only
      // math's test kills them; it still comes first, ahead of the files the other mutant left unused.
      writeFileSync(path.join(root, 'test/math.test.js'), `import * as m from '../src/math.js';\n`);
      const both = [at('mul').site, at('div').site];
      const script: Script = {
        tests: [
          { id: 'a1', file: 'test/a.test.js', hits: both },
          { id: 'b1', file: 'test/b.test.js', hits: both },
          { id: 't1', file: 'test/math.test.js', hits: both },
        ],
        staticHits: { 'test/a.test.js': both, 'test/b.test.js': both, 'test/math.test.js': both },
        staticPerFile: true,
        isolatesFiles: true,
        outcome: (t, m, mode) => (t === 't1' && mode === 'static' && (m === at('mul').num || m === at('div').num) ? 'K' : 'S'),
      };
      const { verdict, log } = await run(script);
      expect(verdict('mul')).toMatchObject({ status: 'Killed', killedBy: ['pkg::t1'] });
      expect(verdict('div')).toMatchObject({ status: 'Killed', killedBy: ['pkg::t1'] });
      const files = (m: number) =>
        log.runs.filter((r) => r.mode === 'static').flatMap((r) => Object.entries(r.staticPlan ?? {}).filter(([, n]) => n === m).map(([f]) => path.basename(f)));
      expect(files(at('mul').num)).toEqual(['math.test.js']);
      expect(files(at('div').num)).toEqual(['math.test.js']);
    });

    it('is tried first in the test file named for its module, even when other files reach it at runtime and it does not', async () => {
      // A test that imports a module inside its body reaches the module's load-time code; a and b
      // do, math only loads it. math's test is still the one written for the module, and kills.
      writeFileSync(path.join(root, 'test/math.test.js'), `import * as m from '../src/math.js';\n`);
      const both = [at('mul').site, at('div').site];
      const script: Script = {
        tests: [
          { id: 'a1', file: 'test/a.test.js', hits: both },
          { id: 'b1', file: 'test/b.test.js', hits: both },
          { id: 't1', file: 'test/math.test.js', hits: [] },
        ],
        staticHits: { 'test/a.test.js': both, 'test/b.test.js': both, 'test/math.test.js': both },
        staticPerFile: true,
        isolatesFiles: true,
        outcome: (t, m, mode) => (t === 't1' && mode === 'static' && (m === at('mul').num || m === at('div').num) ? 'K' : 'S'),
      };
      const { verdict, log } = await run(script);
      expect(verdict('mul')).toMatchObject({ status: 'Killed', killedBy: ['pkg::t1'] });
      expect(verdict('div')).toMatchObject({ status: 'Killed', killedBy: ['pkg::t1'] });
      const files = (m: number) =>
        log.runs.filter((r) => r.mode === 'static').flatMap((r) => Object.entries(r.staticPlan ?? {}).filter(([, n]) => n === m).map(([f]) => path.basename(f)));
      expect(files(at('mul').num)).toEqual(['math.test.js']);
      expect(files(at('div').num)).toEqual(['math.test.js']);
    });

    it('is still killed by a test that only loads its module', async () => {
      const { verdict } = await run(spread({ outcome: (t, m, mode) => (t === 'c1' && m === at('mul').num && mode === 'static' ? 'K' : 'S') }));
      expect(verdict('mul')).toMatchObject({ status: 'Killed', killedBy: ['pkg::c1'] });
    });
  });

  it('credits unhandled errors in a packed run to the mutant of the file they name', async () => {
    const { verdict } = await run(
      staticScript({ staticPerFile: true, isolatesFiles: true, unhandled: (active, mode) => (mode === 'static' && active.includes(at('div').num) ? [{ error: 'late', file: 'test/b.test.js' }] : []) }),
    );
    expect(verdict('div')).toMatchObject({ status: 'Killed', killedBy: ['pkg::unhandled error'] });
    expect(verdict('mul').status).toBe('Survived');
  });

  it('re-runs a packed run mutant by mutant when an unhandled error names no file', async () => {
    const { verdict } = await run(staticScript({ staticPerFile: true, isolatesFiles: true, unhandled: (active, mode) => (mode === 'static' && active.includes(at('div').num) ? [{ error: 'late' }] : []) }));
    expect(verdict('div').status).toBe('Killed');
    expect(verdict('mul').status).toBe('Survived');
  });

  it('splits a packed run that hangs before any try starts, and times out the mutant that hangs alone', async () => {
    const { verdict } = await run(staticScript({ staticPerFile: true, isolatesFiles: true, hangsLoading: new Set([at('div').num]) }));
    expect(verdict('div')).toMatchObject({ status: 'Timeout', statusReason: 'wall-clock backstop' });
    expect(verdict('mul').status).toBe('Survived');
  });

  it('kills a mutant whose test file fails to load in its isolated run', async () => {
    const { verdict } = await run({
      tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site], stateSensitive: 'repeats differently' }],
      loadError: () => 'gone',
    });
    expect(verdict('add')).toMatchObject({ status: 'Killed', statusReason: 'test file failed to load: gone' });
  });

  it('never calls a mutant a survivor when the tests planned for it never reported', async () => {
    const { verdict } = await run({ tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site], stateSensitive: 'repeats differently' }], unreported: new Set(['a1']) });
    expect(verdict('add')).toMatchObject({ status: 'RuntimeError', statusReason: 'the mutant was planned against tests that never reported a result' });
  });
});

describe('the reference engine', () => {
  it('reaches the warm verdicts with a fresh session per mutant', async () => {
    const script: Script = {
      tests: [
        { id: 'a1', file: 'test/a.test.js', hits: [at('add').site, at('sub').site] },
        { id: 'b1', file: 'test/b.test.js', hits: [at('sub').site, at('mul').site] },
      ],
      outcome: (t, m) => (m === at('sub').num && t === 'b1' ? 'K' : 'S'),
    };
    const warm = await run(script);
    const reference = await run(script, { engine: 'reference' });
    expect(statuses(reference.result)).toEqual(statuses(warm.result));
    expect(reference.result.config.engine).toBe('reference');
    expect(reference.log.sessions.filter((s) => s.isolate).length).toBe(3);
  });
});

describe('packages whose sources overlap', () => {
  it('instrument and report each file once', async () => {
    const { factory } = fakeRunner({ tests: [{ id: 'a1', file: 'test/a.test.js', hits: [at('add').site] }], outcome: () => 'K' });
    const m = model();
    m.packages.push({ id: 'again', root: '.', sources: ['src/math.js'], tests: [] });
    const result = await analyse(m, { runners: { vitest: factory }, mutators: MUTATORS, tzapVersion: 'test', verifySurvivors: false });
    expect(result.mutants.map((x) => x.original)).toEqual(['a + b', 'a - b', 'a * b', 'a / b']);
    expect(result.mutants.find((x) => x.original === 'a + b')!.status).toBe('Killed');
  });
});

describe('without tests to run', () => {
  it('reports every mutant uncovered when no package has a runner', async () => {
    const { factory } = fakeRunner({ tests: [] });
    const m = model();
    delete m.packages[0]!.runner;
    const result = await analyse(m, { runners: { vitest: factory }, mutators: MUTATORS, tzapVersion: 'test' });
    expect(new Set(result.mutants.map((x) => x.statusReason))).toEqual(new Set(['no package with a test runner']));
  });

  it('answers from the cache without starting a runner when nothing changed', async () => {
    const { factory, log } = fakeRunner({ tests: [] });
    const result = await analyse(model(), {
      runners: { vitest: factory },
      mutators: MUTATORS,
      tzapVersion: 'test',
      unchanged: { lookup: (d) => ({ ...d, status: 'Killed', killedBy: ['pkg::x'] }), tests: [], red: [] },
    });
    expect(log.sessions).toHaveLength(0);
    expect(result.mutants.every((m) => m.status === 'Killed' && m.cached)).toBe(true);
  });

  it('fails clearly when no adapter serves a package runner', async () => {
    await expect(analyse(model(), { runners: {}, mutators: MUTATORS, tzapVersion: 'test' })).rejects.toThrow('no runner adapter for "vitest" (package pkg)');
  });
});

describe('a workspace package the tests import', () => {
  it('warns when the tests never reach its source: they are loading its built output', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'tzap-engine-ws-'));
    try {
      mkdirSync(path.join(ws, 'lib/src'), { recursive: true });
      mkdirSync(path.join(ws, 'app/test'), { recursive: true });
      mkdirSync(path.join(ws, 'app/node_modules'), { recursive: true });
      writeFileSync(path.join(ws, 'lib/package.json'), JSON.stringify({ name: 'lib', main: 'dist/index.js' }));
      writeFileSync(path.join(ws, 'lib/src/index.js'), SOURCE);
      writeFileSync(path.join(ws, 'app/test/a.test.js'), `import { add } from 'lib';\n`);
      symlinkSync(path.join(ws, 'lib'), path.join(ws, 'app/node_modules/lib'), 'dir');
      const { factory } = fakeRunner({ tests: [{ id: 'a1', file: 'test/a.test.js', hits: [] }] });
      const events: EngineEvent[] = [];
      const result = await analyse(
        {
          schemaVersion: MODEL_SCHEMA_VERSION,
          root: ws,
          packages: [
            { id: 'lib', root: 'lib', sources: ['src/**/*.js'], tests: [] },
            { id: 'app', root: 'app', sources: [], tests: ['test/**/*.test.js'], runner: { kind: 'vitest' } },
          ],
        },
        { runners: { vitest: factory }, mutators: MUTATORS, tzapVersion: 'test', onEvent: (e) => events.push(e) },
      );
      expect(result.mutants.every((m) => m.status === 'NoCoverage')).toBe(true);
      expect(events).toContainEqual({
        type: 'warning',
        message: 'tests import lib but never reach its source: they probably load its built output (check its package.json "exports"/"main", or alias it to src/ in the Vitest config); its 4 mutants will be reported uncovered',
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
