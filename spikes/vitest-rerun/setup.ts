import { inject, afterEach } from 'vitest';
const tz = ((globalThis as any).__tz ??= { a: -1, evals: 0 });
tz.a = (inject as any)('tzapMutant') ?? -1;
afterEach((ctx) => { (ctx.task.meta as any).evals = tz.evals; (ctx.task.meta as any).active = tz.a; });
