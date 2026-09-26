// Full run on fixtures/sample-jest, wall clock of the whole process, median of 3:
// tzap (analyse() through the Jest adapter, warm engine) vs StrykerJS 10 with its Jest runner.
//   node spike/bench.mjs [runs]
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const fixture = path.resolve(import.meta.dirname, '../../../fixtures/sample-jest');
const runs = Number(process.argv[2] ?? 3);
// Through pnpm's bin shim, which sets the NODE_PATH StrykerJS's Jest environment needs under pnpm.
const stryker = path.join(fixture, 'node_modules/.bin', process.platform === 'win32' ? 'stryker.CMD' : 'stryker');
const cases = {
  'tzap warm': [process.execPath, [path.join(import.meta.dirname, 'analyse.mjs'), 'warm'], {}],
  'stryker (default concurrency)': [stryker, ['run', '--logLevel', 'error'], { shell: true }],
  'stryker --concurrency 1': [stryker, ['run', '--logLevel', 'error', '--concurrency', '1'], { shell: true }],
};
const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
for (const [name, [cmd, args, extra]] of Object.entries(cases)) {
  const times = [];
  let tail = '';
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const out = execFileSync(cmd, args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra });
    times.push(performance.now() - t);
    tail = out.trim().split('\n').filter((l) => /All files|"engine"/.test(l)).join(' ');
  }
  console.log(`${name.padEnd(32)} median ${Math.round(median(times))} ms  runs ${times.map(Math.round).join(', ')}  ${tail}`);
}
