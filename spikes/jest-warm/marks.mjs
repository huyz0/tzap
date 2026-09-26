// Spike B.3: where a warm runCLI round's time goes (Jest's own performance marks).
import { createRequire } from 'node:module';
import path from 'node:path';
const fixture = path.resolve(import.meta.dirname, '../../../fixtures/sample-jest');
process.chdir(fixture);
const req = createRequire(path.join(fixture, 'package.json'));
const { runCLI } = req('jest');
const agg = {};
for (let i = 0; i < 21; i++) {
  performance.clearMarks();
  await runCLI({ _: [], $0: 'x', runInBand: true, silent: true, ci: true, reporters: [], watchman: false }, [fixture]);
  const m = Object.fromEntries(performance.getEntriesByType('mark').map((e) => [e.name, e.startTime]));
  if (i === 0) { console.log(Object.keys(m).join(' ')); continue; }
  const s = m['jest/runCLI:start'];
  for (const [k, v] of Object.entries(m)) (agg[k] ??= []).push(v - s);
}
for (const [k, v] of Object.entries(agg)) { v.sort((a, b) => a - b); console.log(k.padEnd(45), v[v.length >> 1].toFixed(1)); }
