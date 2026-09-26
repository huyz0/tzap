/**
 * The user's hooks and test bodies, wrapped once.
 *
 * Mocha treats a failed beforeEach/afterEach hook as a failure of the hook and skips the rest of
 * its suite, which here would be every later try of every test in it. tzap keeps it to the try, as
 * Vitest and Jest do for a failing hook: the error is the try's, the remaining beforeEach hooks and
 * the body are not run, the afterEach hooks are, and the next try runs as usual. A try whose
 * mutant is already killed in this run (X) runs none of the user's hooks or body.
 */
import type { MochaHook, MochaTest } from './mocha.js';

/** What the wrappers need of the try in progress. */
export interface TryState {
  /** Which try of its test this is, from 0. */
  index: number;
  /** How many tries the test has in this run. */
  total: number;
  /** The mutant was already killed in this run: nothing of the user's runs. */
  skipped: boolean;
  error: unknown;
  /** A beforeEach/afterEach hook failed around this try: the try failed, its body is not run. */
  hookFailed: boolean;
  done: boolean;
}

/** The try in progress, if any. */
export type CurrentTry = () => TryState | undefined;

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Fails a try that is not its test's last, so Mocha's retry loop runs the next. Made once: a new
 * Error per try would capture a stack every time.
 */
export const NEXT = Object.assign(new Error('tzap: next try'), { stack: 'tzap: next try' });
const WRAPPED = Symbol.for('tzap.mocha.wrapped');

/** Mocha's `this.skip()` signal: PendingError in Mocha 12, a plain Pending object before. */
const isPendingSignal = (e: unknown) => {
  const name = (e as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name === 'PendingError' || name === 'Pending';
};

/** A function standing in for `orig`: same arity (Mocha reads it to tell callback style) and source. */
function standIn(orig: AnyFn, w: AnyFn): AnyFn {
  Object.defineProperty(w, 'length', { value: orig.length });
  Object.defineProperty(w, 'toString', { value: () => orig.toString() });
  (w as unknown as Record<symbol, boolean>)[WRAPPED] = true;
  return w;
}

const wrappable = (fn: unknown): fn is AnyFn => typeof fn === 'function' && !(fn as unknown as Record<symbol, boolean>)[WRAPPED];

/** Keeps a beforeEach/afterEach hook's failure to the try it failed. */
export function wrapHook(h: MochaHook, kind: 'before' | 'after', current: CurrentTry): void {
  const orig = h.fn;
  if (!wrappable(orig)) return;
  const skip = () => {
    const c = current();
    return c !== undefined && !c.done && (c.skipped || (kind === 'before' && c.hookFailed));
  };
  const fail = (e: unknown): boolean => {
    const c = current();
    if (!c || c.done || isPendingSignal(e)) return false;
    if (c.error === undefined) c.error = e ?? new Error('hook failed');
    c.hookFailed = true;
    return true;
  };
  h.fn =
    orig.length > 0
      ? standIn(orig, function (this: unknown, done: unknown, ...rest: unknown[]) {
          const cb = done as (e?: unknown) => void;
          if (skip()) return cb();
          try {
            return orig.call(this, (e?: unknown) => (e && fail(e) ? cb() : cb(e)), ...rest);
          } catch (e) {
            if (fail(e)) return cb();
            throw e;
          }
        })
      : standIn(orig, function (this: unknown) {
          if (skip()) return undefined;
          let r: unknown;
          try {
            r = orig.call(this);
          } catch (e) {
            if (fail(e)) return undefined;
            throw e;
          }
          if (r && typeof (r as Promise<unknown>).then === 'function') {
            return (r as Promise<unknown>).then(
              () => undefined,
              (e: unknown) => {
                if (!fail(e)) throw e;
              },
            );
          }
          return r;
        });
}

/**
 * The test body: records a failure as the try's, and fails a try that is not the test's last with
 * the NEXT marker, so that Mocha's retry loop runs the next one. The last try reports its real
 * result. Not run at all behind a failed beforeEach (the hook's error is the try's) or for an
 * already-killed mutant.
 */
export function wrapTest(t: MochaTest, current: CurrentTry): void {
  const orig = t.fn;
  if (!wrappable(orig)) return;
  t.fn = standIn(orig, function (this: unknown, ...args: unknown[]) {
    const c = current();
    if (!c || c.done) return orig.apply(this, args);
    const last = c.index >= c.total - 1;
    /** What the body reports to Mocha: the marker while tries remain, else its own result. */
    const settle = (failed: boolean, e?: unknown): unknown => {
      if (failed && !c.done && c.error === undefined) c.error = e ?? new Error('failed with no reason');
      return last ? (failed ? (e ?? new Error('failed with no reason')) : undefined) : NEXT;
    };
    const callback = orig.length > 0;
    const cb = args[0] as (e?: unknown) => void;
    if (c.skipped || c.hookFailed) {
      const out = settle(c.hookFailed, c.error);
      if (callback) return cb(out);
      if (out !== undefined) throw out;
      return undefined;
    }
    let r: unknown;
    try {
      r = callback ? orig.call(this, (e?: unknown) => cb(e ? settle(true, e) : settle(false)), ...args.slice(1)) : orig.apply(this, args);
    } catch (e) {
      if (isPendingSignal(e)) throw e;
      throw settle(true, e);
    }
    if (callback) return r;
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      return (r as Promise<unknown>).then(
        () => {
          const out = settle(false);
          if (out !== undefined) throw out;
        },
        (e: unknown) => {
          if (isPendingSignal(e)) throw e;
          throw settle(true, e);
        },
      );
    }
    const out = settle(false);
    if (out !== undefined) throw out;
    return r;
  });
}
