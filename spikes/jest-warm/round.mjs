// Spike B.1: cost of one runCLI({runInBand}) round on fixtures/sample-jest, in one process.
import { createRequire } from 'node:module';
import path from 'node:path';
const fixture = path.resolve(import.meta.dirname, '../../../fixtures/sample-jest');
process.chdir(fixture);
const req = createRequire(path.join(fixture, 'package.json'));
const { runCLI } = req('jest');
const N = Number(process.argv[2] ?? 20);
const times = [];
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const s = performance.now();
  const { results } = await runCLI({ _: [], $0: 'x', runInBand: true, silent: true, ci: true, reporters: [], watchman: false, cache: true }, [fixture]);
  times.push(performance.now() - s);
  if (results.numPassedTests !== 5) throw new Error('bad');
}
const sorted = times.slice(1).sort((a, b) => a - b);
console.log(JSON.stringify({ first: times[0].toFixed(1), median: sorted[sorted.length >> 1].toFixed(1), p10: sorted[Math.floor(sorted.length * 0.1)].toFixed(1), p90: sorted[Math.floor(sorted.length * 0.9)].toFixed(1), totalMs: (performance.now() - t0).toFixed(0) }));
