/**
 * The object instrumented code talks to, at `globalThis.__tzap`.
 *
 * This package is loaded into the user's module graph, possibly inside a DOM-like test
 * environment, so it imports nothing at all — not even Node built-ins. A test walks its built
 * output and fails on any import.
 *
 * Field names are one letter because every mutation site in the user's code references them.
 */
export interface TzapRuntime {
  /** Active mutant number; -1 when none is active. */
  a: number;
  /** Hit counters, indexed by instrumentation site. */
  c: Uint32Array;
  /** Hits of the active mutant's replacement in the current try. */
  n: number;
  /** Limit on `n` before the try is declared hung. */
  N: number;
  /** Loop back-edges taken in instrumented code during the current try. */
  l: number;
  /** Limit on `l` before the try is declared hung. */
  L: number;
  /** Sticky hang flag: once set, every guard throws again, so a user `catch` cannot hide it. */
  h: number;
  /** Ensures the counters can index `site`. */
  g(site: number): void;
  /** Called on entry to an active mutant's replacement. */
  m(): void;
  /** Declares the current try hung, and throws. */
  x(): never;
}

export const RUNTIME_GLOBAL = '__tzap';

export class TzapHangError extends Error {
  constructor(reason: string) {
    super(`tzap: mutant declared hung (${reason})`);
    this.name = 'TzapHangError';
  }
}

/**
 * Source of the factory. Instrumented files inline a call to it so that code loaded outside any
 * tzap-controlled worker (a child process a test spawns, say) still runs, unmutated.
 * Kept as a string so it is byte-for-byte the same code in both places.
 */
export const RUNTIME_FACTORY_SOURCE = `function(){var t={a:-1,c:new Uint32Array(1024),n:0,N:Infinity,l:0,L:Infinity,h:0,
g:function(s){if(s>=t.c.length){var b=new Uint32Array(Math.max(s+1,t.c.length*2));b.set(t.c);t.c=b;}},
m:function(){if(++t.n>t.N||t.h)t.x();},
x:function(){t.h=1;var e=new Error("tzap: mutant declared hung");e.name="TzapHangError";throw e;}};
var e=typeof process!=="undefined"&&process.env&&process.env.TZAP_ACTIVE_MUTANT;if(e)t.a=+e;return t;}`;

const factory = new Function(`return (${RUNTIME_FACTORY_SOURCE})`)() as () => TzapRuntime;

/** Returns the runtime on `globalThis`, creating it if this is the first instrumented code to run. */
export function install(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): TzapRuntime {
  const existing = target[RUNTIME_GLOBAL] as TzapRuntime | undefined;
  if (existing) return existing;
  const rt = factory();
  target[RUNTIME_GLOBAL] = rt;
  return rt;
}

/**
 * The line prepended to every instrumented file. `maxSite` is the highest site number the file
 * uses, so the counters are large enough before the first site is reached.
 */
export function runtimeHeader(maxSite: number): string {
  return `var ${RUNTIME_GLOBAL}=globalThis.${RUNTIME_GLOBAL}||(globalThis.${RUNTIME_GLOBAL}=(${RUNTIME_FACTORY_SOURCE.replace(/\n/g, '')})());${RUNTIME_GLOBAL}.g(${maxSite});`;
}

/**
 * The default limit while a static mutant is active outside any test — while modules load, in
 * beforeAll/afterAll hooks, in describe callbacks. Engines pass a measured one instead (ten times
 * the loop iterations the unmutated files needed while loading); this is the fallback.
 */
export const STATIC_LIMIT = 10_000_000;

/** Activates a static mutant for everything that runs until the next try begins. */
export function activateStatic(rt: TzapRuntime, mutant: number, limit: number = STATIC_LIMIT): void {
  rt.a = mutant;
  rt.n = 0;
  rt.N = limit;
  rt.l = 0;
  rt.L = limit;
  rt.h = 0;
}

/** Resets per-try state before a test runs. */
export function beginTry(rt: TzapRuntime, mutant: number, hitLimit: number, loopLimit: number): void {
  rt.a = mutant;
  rt.n = 0;
  rt.N = hitLimit;
  rt.l = 0;
  rt.L = loopLimit;
  rt.h = 0;
}

/** Ends a try; returns whether it was declared hung. */
export function endTry(rt: TzapRuntime): { hung: boolean; loops: number } {
  const hung = rt.h !== 0;
  const loops = rt.l;
  rt.a = -1;
  rt.n = 0;
  rt.N = Infinity;
  rt.l = 0;
  rt.L = Infinity;
  rt.h = 0;
  return { hung, loops };
}

/** Collects the sites hit since the last call, with counts, and zeroes them. */
export function drainHits(rt: TzapRuntime): Array<[site: number, hits: number]> {
  const out: Array<[number, number]> = [];
  const c = rt.c;
  for (let i = 0; i < c.length; i++) {
    const v = c[i]!;
    if (v !== 0) {
      out.push([i, v]);
      c[i] = 0;
    }
  }
  return out;
}
