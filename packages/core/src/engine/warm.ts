/**
 * The warm engine: rounds of many mutants per runner invocation, in sessions that stay up.
 *
 * Controls — the test run unmutated — decide which mutant tries count. In an ordinary round each
 * test's tries are bracketed, `[control, m1, ..., mk, control]`: when both controls pass, every
 * try in between ran from state the unmutated test is happy with. When one fails — a mutant
 * corrupted state its module keeps, a registry or a cache — those tries are tried again with a
 * control before each, `[control, m1, control, m2, ...]`, where a try counts only if the control
 * just before it passed. The corrupting mutant is then measured cleanly, and so is everything
 * after it. Only the pairs that ran dirty are tried again, never a whole set.
 */
import path from 'node:path';
import type { RunResult, Try } from '@tzap/protocol';
import { addTo, control, decidedCount, limitsFor, type EngineRun, type IsolatedMutant, type Pending } from './run.js';

/**
 * How many times one round may be restarted after the wall-clock backstop: each restart drops the
 * mutants that hung, so this bounds a round only when mutants keep hanging one after another.
 */
const MAX_BACKSTOP_RESTARTS = 50;

interface Outcome {
  /** Every try that killed the mutant this round. */
  kills: Array<{ key: string; timeout: boolean; message?: string }>;
  tested: number;
}

interface Round {
  verdicts: Map<number, Outcome>;
  /** (mutant, test key) pairs whose try ran in state that could not be trusted. */
  dirty: Map<number, Set<string>>;
  /** Mutants a trusted try never reached. */
  unreached: Set<number>;
}

/** Decides what it can of `covered`; returns the mutants whose warm verdict could not be trusted, for the isolated path. */
export async function warmEngine(run: EngineRun, covered: Pending[]): Promise<IsolatedMutant[]> {
  const { results, tests, emit, options } = run;
  const fallback: IsolatedMutant[] = [];
  let round = 0;
  let verifying = 0;
  const toFallback = (p: Pending) => {
    fallback.push({ d: p.d, tests: p.tests });
    results.set(p.d.num, { ...p.d, status: 'Pending' });
  };
  for (const p of covered) if (p.warm.length === 0) toFallback(p);

  /** Tries each mutant against the given tests; `interleave` puts a control before every try. */
  const runRound = async (entries: Array<{ p: Pending; tests: string[] }>, interleave: boolean): Promise<Round> => {
    round++;
    const byPkg = new Map<string, Map<string, Try[]>>();
    let tries = 0;
    for (const { p, tests: keys } of entries) {
      for (const key of keys) {
        const t = tests.get(key)!;
        let plan = byPkg.get(t.pkg);
        if (!plan) byPkg.set(t.pkg, (plan = new Map()));
        let list = plan.get(t.runnerId);
        if (!list) plan.set(t.runnerId, (list = [control(t)]));
        list.push({ m: p.d.num, ...limitsFor(t, p.d.site) });
        if (interleave) list.push(control(t));
        tries++;
      }
    }
    if (!interleave) for (const [pkgId, plan] of byPkg) for (const [id, list] of plan) list.push(control(tests.get(`${pkgId}::${id}`)!));
    const started = performance.now();
    const r: Round = { verdicts: new Map(), dirty: new Map(), unreached: new Set() };
    for (const [pkgId, plan] of byPkg) {
      const res = await runWithRecovery(run, pkgId, Object.fromEntries(plan));
      collect(pkgId, res, r, interleave);
      // An unhandled error failed the run, and no try owns it: every mutant tried here that no
      // test killed is decided on its own, in isolation, where the error is attributable.
      if (res.unhandledErrors?.length && !run.noisyUnhandled.has(pkgId)) {
        for (const list of plan.values()) for (const tr of list) if (tr.m >= 0 && !r.verdicts.get(tr.m)?.kills.length) r.unreached.add(tr.m);
      }
      // A planned try the runner never reported on decided nothing: try it again.
      const reported = new Set(res.tests.flatMap((t) => (t.tries ?? []).map(([m]) => `${t.id}\0${m}`)));
      for (const [id, list] of plan) {
        for (const tr of list) if (tr.m >= 0 && !reported.has(`${id}\0${tr.m}`)) addTo(r.dirty, tr.m, `${pkgId}::${id}`);
      }
    }
    emit({ type: 'round', round, tries, ms: Math.round(performance.now() - started) });
    return r;
  };

  const decide = (p: Pending, o: Outcome | undefined) => {
    p.completed += o?.tested ?? 0;
    if (!o?.kills.length) return false;
    // Several tests can kill a mutant in one round; which of them reports first depends on
    // scheduling. The one credited is the earliest in the mutant's own test order.
    const rank = (k: string) => {
      const i = p.tests.indexOf(k);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const kill = o.kills.reduce((a, b) => (rank(b.key) < rank(a.key) || (rank(b.key) === rank(a.key) && b.key < a.key) ? b : a));
    if (kill.timeout) results.set(p.d.num, { ...p.d, status: 'Timeout', statusReason: kill.message ?? 'declared hung', coveredBy: p.tests, killedBy: [kill.key] });
    else results.set(p.d.num, { ...p.d, status: 'Killed', statusReason: kill.message, killedBy: [kill.key], coveredBy: p.tests, testsCompleted: p.completed });
    return true;
  };
  const survive = (p: Pending) => {
    // Survived every test the warm engine could trust. Confirmed in isolation unless told not
    // to; covered by state-sensitive tests too, it always is.
    const verify = options.verifySurvivors === true || (options.verifySurvivors !== false && p.tests.some((k) => tests.get(k)?.stateful !== false));
    if (p.warm.length < p.tests.length || verify) {
      verifying++;
      toFallback(p);
    } else results.set(p.d.num, { ...p.d, status: 'Survived', coveredBy: p.tests, testsCompleted: p.completed });
  };
  const redo = new Map<number, { p: Pending; tests: Set<string> }>();
  const settle = (p: Pending, r: Round, done: boolean) => {
    if (decide(p, r.verdicts.get(p.d.num))) {
      redo.delete(p.d.num);
      return;
    }
    if (r.unreached.has(p.d.num)) {
      redo.delete(p.d.num);
      toFallback(p);
      return;
    }
    const d = r.dirty.get(p.d.num);
    if (d?.size) {
      const again = redo.get(p.d.num) ?? { p, tests: new Set<string>() };
      for (const k of d) again.tests.add(k);
      redo.set(p.d.num, again);
    }
    if (done && !redo.has(p.d.num)) survive(p);
    else if (done) results.set(p.d.num, { ...p.d, status: 'Pending' });
  };
  const progress = () => emit({ type: 'progress', decided: decidedCount(run), total: run.total });

  // Round 1 tries each mutant against its most likely killer only; round 2 every remaining
  // covering test, with in-worker skipping once a mutant dies.
  let active = covered.filter((p) => p.warm.length > 0);
  let first = true;
  while (active.length > 0) {
    const entries = active.map((p) => {
      const to = first ? p.cursor + 1 : p.warm.length;
      const e = { p, tests: p.warm.slice(p.cursor, to) };
      p.cursor = to;
      return e;
    });
    first = false;
    const r = await runRound(entries, false);
    for (const p of active) settle(p, r, p.cursor >= p.warm.length);
    progress();
    active = active.filter((p) => !results.has(p.d.num) && p.cursor < p.warm.length);
  }

  // The pairs that ran in untrusted state, again, each behind its own control, until a round
  // resolves none of them.
  while (redo.size > 0) {
    const before = [...redo.values()].reduce((n, x) => n + x.tests.size, 0);
    const entries = [...redo.values()].map((x) => ({ p: x.p, tests: [...x.tests] }));
    for (const e of entries) results.delete(e.p.d.num);
    redo.clear();
    const r = await runRound(entries, true);
    for (const { p } of entries) settle(p, r, true);
    const after = [...redo.values()].reduce((n, x) => n + x.tests.size, 0);
    progress();
    if (after >= before) {
      // No progress: the state these tests start from is itself broken (a test that depends
      // on another it no longer follows). Decide them in isolation.
      for (const { p } of redo.values()) toFallback(p);
      redo.clear();
    }
  }

  for (const f of fallback) results.delete(f.d.num);
  if (verifying) emit({ type: 'info', message: `confirming ${verifying} warm survivors in isolation` });
  if (fallback.length > verifying) emit({ type: 'warning', message: `${fallback.length - verifying} mutants re-decided in isolation: never reached in the warm run, or covered by tests whose warm runs could not be trusted` });
  return fallback;
}

/**
 * Folds one run's tries into verdicts. Bracketed (`interleave` false): a test's tries count only
 * if both controls around them passed. Interleaved: a try counts if the control just before it
 * passed. A try that does not count makes its (mutant, test) pair dirty; one that counts but
 * never reached the mutant makes the mutant unreached.
 */
function collect(pkgId: string, res: RunResult, round: Round, interleave: boolean): void {
  for (const t of res.tests) {
    const tries = t.tries ?? [];
    const key = `${pkgId}::${t.id}`;
    const bracketFailed = !interleave && tries.some(([m, outcome]) => m < 0 && outcome !== 'S');
    let clean = true;
    for (const [m, outcome, message] of tries) {
      if (m < 0) {
        clean = outcome === 'S';
        continue;
      }
      let o = round.verdicts.get(m);
      if (!o) round.verdicts.set(m, (o = { kills: [], tested: 0 }));
      if (outcome === 'X') continue;
      if (bracketFailed || (interleave && !clean)) {
        addTo(round.dirty, m, key);
        continue;
      }
      if (outcome === 'U') {
        round.unreached.add(m);
        continue;
      }
      o.tested++;
      if (outcome === 'K' || outcome === 'T') o.kills.push({ key, timeout: outcome === 'T', ...(message !== undefined ? { message } : {}) });
    }
  }
}

/** Runs a plan; if a hang outlives the budget, marks what was in flight as Timeout and retries the rest. */
async function runWithRecovery(run: EngineRun, pkgId: string, plan: Record<string, Try[]>): Promise<RunResult> {
  const { tests, silenceMs: budgetMs } = run;
  const merged: RunResult = { id: 0, tests: [], files: [], durationMs: 0 };
  let remaining = plan;
  for (let attempt = 0; attempt < MAX_BACKSTOP_RESTARTS; attempt++) {
    // Only the files that hold a planned test: every other file would be loaded and collected
    // for nothing, a fixed cost per round that dwarfs the tries on a small diff.
    const files = [...new Set(Object.keys(remaining).map((id) => path.resolve(run.root, tests.get(`${pkgId}::${id}`)!.file)))];
    const res = await run.warm.get(pkgId)!.run({ id: run.nextRunId(), mode: 'mutate', plan: remaining, files, budgetMs });
    if (!res.timedOut) {
      merged.tests.push(...res.tests);
      merged.files.push(...res.files);
      if (res.unhandledErrors?.length) {
        merged.unhandledErrors = [...(merged.unhandledErrors ?? []), ...res.unhandledErrors];
        merged.unhandledErrorFiles = [...(merged.unhandledErrorFiles ?? []), ...res.unhandledErrors.map((_, i) => res.unhandledErrorFiles?.[i] ?? null)];
      }
      return merged;
    }
    const inFlight = (res.inFlight ?? []).filter((x) => x.mutant >= 0);
    const hung = new Set(inFlight.map((x) => x.mutant));
    if (hung.size === 0) throw new Error(`a test run went silent for ${Math.round(budgetMs / 1000)} s with no mutant try in flight: a hook outside any test (beforeAll/afterAll, a global setup) is blocking; it does so without any mutant, so check the suite on its own`);
    run.emit({ type: 'warning', message: `wall-clock backstop: mutants ${[...hung].join(', ')} declared hung` });
    // Each hung try is credited to the test it was running.
    for (const { test, mutant } of inFlight) {
      const t = tests.get(`${pkgId}::${test}`);
      merged.tests.push({ id: test, name: t?.name ?? test, file: t?.file ?? '', state: 'fail', duration: budgetMs, tries: [[mutant, 'T', 'wall-clock backstop']] });
    }
    const s = run.sessionFor(run.runnerPackages.find((p) => p.id === pkgId)!);
    await s.start();
    run.warm.set(pkgId, s);
    const next: Record<string, Try[]> = {};
    for (const [test, list] of Object.entries(remaining)) {
      const kept = list.filter((t) => !hung.has(t.m));
      if (kept.some((t) => t.m >= 0)) next[test] = kept;
    }
    remaining = next;
  }
  throw new Error('too many hung runs in one round');
}
