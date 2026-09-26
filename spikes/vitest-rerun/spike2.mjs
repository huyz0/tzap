import { createVitest } from 'vitest/node';
const isolate = process.argv[2] === 'isolate';
const N = +process.argv[3] || 1000;
const v = await createVitest('test', { watch: false, pool: 'threads', isolate, setupFiles: ['./test/setup2.ts'], include: ['test/**/*.test.ts'], reporters: [], fileParallelism: false }, {});
const [spec] = await v.globTestSpecifications();
// plan: 'adds' runs N mutants alternating 1 / 99 ; 'muls' runs 2 and -1
const addsPlan = Array.from({ length: N }, (_, i) => i % 2 ? 1 : 99);
v.provide('tzapPlan', { adds: addsPlan, muls: [2, 5] });
for (let r = 0; r < 3; r++) {
  const s = performance.now();
  const res = await v.runTestSpecifications([spec]);
  const el = performance.now() - s;
  const tests = [...res.testModules[0].children.allTests()];
  const adds = tests.find(t => t.name === 'adds'), muls = tests.find(t => t.name === 'muls');
  const m = adds.meta().tzap;
  const killed = m.filter(x => x[1] === 'K').length;
  console.log(`isolate=${isolate} tries=${m.length} killed=${killed} state=${adds.result().state} muls=${JSON.stringify(muls.meta().tzap)} filler=${tests.find(t=>t.name==='filler 0').result().state} run=${el.toFixed(0)}ms per-try=${(el/m.length*1000).toFixed(0)}us`);
}
await v.close();
