// Spike B.4: the adapter's own costs on fixtures/sample-jest (unmutated instrumentation: empty map).
//   node spike/adapter.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJestSession } from '../dist/index.js';

const root = path.resolve(import.meta.dirname, '../../../fixtures/sample-jest').split(path.sep).join('/');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tzap-jest-spike-'));
const instrumented = path.join(tmp, 'i.json');
writeFileSync(instrumented, '{}');
const pkg = { id: 'sample-jest', root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest' } };
const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const time = async (f) => {
  const t = performance.now();
  await f();
  return performance.now() - t;
};

const s = createJestSession({ root, pkg, instrumented, tmpDir: tmp });
const start = await time(() => s.start());
const cov1 = await time(() => s.run({ id: 1, mode: 'coverage' }));
const cov = [];
for (let i = 0; i < 10; i++) cov.push(await time(() => s.run({ id: 10 + i, mode: 'coverage' })));
const SMALL = 'test/discount.test.ts::discountedPrice > applies a small discount';
const JOIN = 'test/strings.test.ts::joins non-blank names';
const plan = (n) => {
  const tries = [{ m: -1, N: Infinity, L: 1e5 }];
  for (let i = 0; i < n; i++) tries.push({ m: 1000 + i, N: 1000, L: 1e5 });
  tries.push({ m: -1, N: Infinity, L: 1e5 });
  return { [SMALL]: tries, [JOIN]: tries };
};
const rows = [];
for (const n of [0, 10, 100, 1000, 5000]) {
  const ts = [];
  for (let i = 0; i < 5; i++) ts.push(await time(() => s.run({ id: 100 + n + i, mode: 'mutate', plan: plan(n) })));
  rows.push([n * 2, median(ts)]);
}
const file = `${root}/test/strings.test.ts`.toLowerCase();
const st = [];
for (let i = 0; i < 10; i++) st.push(await time(() => s.run({ id: 200 + i, mode: 'static', staticMutant: 5, files: [file], plan: { [JOIN]: [{ m: 5, N: 1000, L: 1e5 }] } })));
await s.close();
console.log(`start ${start.toFixed(0)} ms; first coverage run ${cov1.toFixed(0)} ms; warm coverage run (median of 10) ${median(cov).toFixed(1)} ms`);
for (const [tries, ms] of rows) console.log(`mutate round, 2 files, ${String(tries).padStart(5)} mutant tries: ${ms.toFixed(1)} ms`);
const [t0, m0] = rows[0];
const [t1, m1] = rows[rows.length - 1];
console.log(`marginal per try: ${(((m1 - m0) / (t1 - t0)) * 1000).toFixed(0)} us`);
console.log(`static run, one test file (median of 10): ${median(st).toFixed(1)} ms`);
