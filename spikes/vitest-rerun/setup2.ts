import { inject, beforeAll, beforeEach, afterEach } from 'vitest';
const tz = ((globalThis as any).__tz ??= { a: -1, evals: 0 });
const plan: Record<string, number[]> = (inject as any)('tzapPlan') ?? {};
const walk = (s: any, f: (t: any) => void) => { for (const t of s.tasks ?? []) { if (t.type === 'test') f(t); else walk(t, f); } };
beforeAll(({}: any, file: any) => {
  walk(file, (t) => { const p = plan[t.name]; if (!p) { t.mode = 'skip'; } else { t.repeats = p.length - 1; t.meta.tzap = []; } });
});
beforeEach((ctx) => { const t: any = ctx.task; tz.a = plan[t.name][t.result.repeatCount ?? 0]; });
afterEach((ctx) => {
  const t: any = ctx.task; const failed = t.result.state === 'fail';
  t.meta.tzap.push([tz.a, failed ? 'K' : 'S']);
  if (failed) { t.result.state = 'pass'; t.result.errors = undefined; }
  tz.a = -1;
});
