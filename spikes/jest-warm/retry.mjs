import { createRequire } from 'node:module';
import path from 'node:path';
const fixture = path.resolve(import.meta.dirname, '../../../fixtures/sample-jest');
const proj = path.resolve(import.meta.dirname, 'proj');
process.env.SPIKE_FIXTURE = fixture;
const req = createRequire(path.join(fixture, 'package.json'));
const { runCLI } = req('jest');
const config = JSON.stringify({ rootDir: proj, testEnvironment: path.resolve(import.meta.dirname, 'env.cjs'), transform: {}, testMatch: ['**/*.test.js'] });
const run = async (tries) => {
  globalThis.__spike = { tries, outcomes: [] };
  const s = performance.now();
  const { results } = await runCLI({ _: [], $0: 'x', runInBand: true, silent: true, ci: true, reporters: [], watchman: false, config }, [proj]);
  const ms = performance.now() - s;
  const o = globalThis.__spike.outcomes; if (tries < 3) console.log(o);
  const ok = o.length === tries && o.every((x, i) => x === (process.env.SPIKE_ALL_S ? 'S' : i % 2 ? 'K' : 'S'));
  return { tries, ms: +ms.toFixed(1), ok, passed: results.numPassedTests, failed: results.numFailedTests, hooks: globalThis.__spike.hooks };
};
await run(1);
for (const n of (process.env.SPIKE_N ?? '1,1,1000,1000,10000,10000,1,100000').split(',').map(Number)) console.log(JSON.stringify(await run(n)));
