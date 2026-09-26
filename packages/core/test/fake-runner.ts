/**
 * A scripted runner session for engine tests: every test's coverage and every try's outcome come
 * from a script, so a test can put the engine in exactly the situation a rule is for (a mutant
 * that corrupts state, one that hangs, an unhandled error) and check the verdict it reaches.
 */
import path from 'node:path';
import { normPath, type RunnerFactory, type RunRequest, type RunResult, type SessionOptions, type TestOutcome, type TryOutcome } from '@tzap/protocol';

export interface FakeTest {
  id: string;
  /** Test file, relative to the package root. */
  file: string;
  /** Sites the test reaches. */
  hits: number[];
  duration?: number;
  /** Fails unmutated. */
  red?: string;
  stateSensitive?: string;
}

/** What a try does: an outcome letter, or `hang` (the session goes silent until killed). */
export type Behaviour = TryOutcome | 'hang';

export interface Script {
  tests: FakeTest[];
  /** Sites a test file reaches while it loads: static mutants. */
  staticHits?: Record<string, number[]>;
  /** A mutant try's outcome. Default: survives. */
  outcome?(test: string, mutant: number, mode: 'mutate' | 'static'): Behaviour;
  /** Mutants that leave state behind: the next unmutated try of the same test in the same session fails. */
  corrupts?: ReadonlySet<number>;
  /** Mutants that break the test's state for good: every later unmutated try in the session fails. */
  poisons?: ReadonlySet<number>;
  /** Tests a run leaves out of its result, as a runner that lost them would. */
  unreported?: ReadonlySet<string>;
  /** A static run in which this file fails to load. */
  loadError?(file: string, mutant: number): string | undefined;
  /** Unhandled errors a run with these active mutants reports, with the file each is attributed to. */
  unhandled?(mutants: number[], mode: 'coverage' | 'mutate' | 'static'): Array<{ error: string; file?: string }>;
  /** Mutants after whose try the next unmutated try of the test stalls the session (warm runs). */
  stallsControl?: ReadonlySet<number>;
  /** Hangs while loading, before any try starts, when this mutant is active. */
  hangsLoading?: ReadonlySet<number>;
  staticPerFile?: boolean;
  isolatesFiles?: boolean;
}

export interface FakeLog {
  sessions: Array<{ isolate: boolean }>;
  runs: RunRequest[];
}

export function fakeRunner(script: Script): { factory: RunnerFactory; log: FakeLog } {
  const log: FakeLog = { sessions: [], runs: [] };
  const factory: RunnerFactory = (o: SessionOptions) => {
    log.sessions.push({ isolate: o.isolate === true });
    const pkgRoot = path.resolve(o.root, o.pkg.root);
    const abs = (f: string) => path.resolve(pkgRoot, f);
    const byId = new Map(script.tests.map((t) => [t.id, t]));
    /** Tests whose next control fails: state a mutant left in this session. */
    const tainted = new Set<string>();
    const poisoned = new Set<string>();
    return {
      kind: 'fake',
      start: async () => ({ runnerVersion: 'fake', staticPerFile: script.staticPerFile, isolatesFiles: script.isolatesFiles }),
      listFiles: async () => [...new Set(script.tests.map((t) => abs(t.file)))],
      close: async () => {},
      run: async (req: RunRequest): Promise<RunResult> => {
        log.runs.push(req);
        const files = [...new Set(script.tests.map((t) => t.file))].filter((f) => !req.files || req.files.some((x) => normPath(x) === normPath(abs(f))));
        const base = (t: FakeTest): TestOutcome => ({ id: t.id, name: t.id, file: abs(t.file), state: 'pass', duration: t.duration ?? 1 });
        if (req.mode === 'coverage') {
          const unhandled = script.unhandled?.([], 'coverage') ?? [];
          return {
            ...(unhandled.length ? { unhandledErrors: unhandled.map((u) => u.error), unhandledErrorFiles: unhandled.map((u) => (u.file ? abs(u.file) : null)) } : {}),
            id: req.id,
            durationMs: 1,
            tests: script.tests
              .filter((t) => files.includes(t.file))
              .map((t) => ({ ...base(t), ...(t.red ? { state: 'fail' as const, message: t.red } : {}), hits: t.hits.map((s) => [s, 1] as [number, number]), loops: 0, ...(t.stateSensitive ? { stateSensitive: t.stateSensitive } : {}) })),
            files: files.map((f) => ({ file: abs(f), staticHits: (script.staticHits?.[f] ?? []).map((s) => [s, 1] as [number, number]), loadLoops: 0 })),
          };
        }
        const mode = req.mode;
        const mutantOf = (file: string) => req.staticPlan?.[normPath(abs(file))] ?? req.staticMutant ?? -1;
        const active = mode === 'static' ? [...new Set(files.map(mutantOf))].filter((m) => m >= 0) : [...new Set(Object.values(req.plan ?? {}).flatMap((l) => l.map((t) => t.m)))].filter((m) => m >= 0);
        if (mode === 'static' && active.some((m) => script.hangsLoading?.has(m))) return { id: req.id, durationMs: 1, tests: [], files: [], timedOut: true, inFlight: [] };
        const result: RunResult = { id: req.id, durationMs: 1, tests: [], files: [] };
        const failedFiles = new Set<string>();
        for (const f of files) {
          const error = mode === 'static' ? script.loadError?.(f, mutantOf(f)) : undefined;
          if (error) failedFiles.add(f);
          result.files.push({ file: abs(f), ...(error ? { error } : {}) });
        }
        const killed = new Set<number>();
        const stalling = new Set<string>();
        for (const [id, plan] of Object.entries(req.plan ?? {})) {
          const t = byId.get(id)!;
          if (failedFiles.has(t.file)) continue;
          const out: TestOutcome = { ...base(t), tries: [] };
          for (const tr of plan) {
            const m = mode === 'static' ? mutantOf(t.file) : tr.m;
            if (m < 0) {
              if (stalling.has(id)) return { id: req.id, durationMs: 1, tests: [], files: [], timedOut: true, inFlight: [{ test: id, mutant: -1 }] };
              out.tries!.push([m, tainted.has(id) || poisoned.has(id) ? 'K' : 'S']);
              tainted.delete(id);
              continue;
            }
            if (mode === 'mutate' && killed.has(m)) {
              out.tries!.push([m, 'X']);
              continue;
            }
            const b = script.outcome?.(id, m, mode) ?? 'S';
            if (b === 'hang') return { id: req.id, durationMs: 1, tests: [], files: [], timedOut: true, inFlight: [{ test: id, mutant: m }] };
            if (b === 'K' || b === 'T') killed.add(m);
            out.tries!.push(b === 'K' ? [m, b, `${id} failed with ${m}`] : [m, b]);
            if (script.corrupts?.has(m)) tainted.add(id);
            if (script.poisons?.has(m)) poisoned.add(id);
            if (script.stallsControl?.has(m)) stalling.add(id);
          }
          if (!script.unreported?.has(id)) result.tests.push(out);
        }
        const unhandled = script.unhandled?.(active, mode) ?? [];
        if (unhandled.length) {
          result.unhandledErrors = unhandled.map((u) => u.error);
          result.unhandledErrorFiles = unhandled.map((u) => (u.file ? abs(u.file) : null));
        }
        return result;
      },
    };
  };
  return { factory, log };
}
