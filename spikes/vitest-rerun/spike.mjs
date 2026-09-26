import { createVitest } from 'vitest/node';
const pool = process.argv[2] ?? 'threads';
const t0 = performance.now();
const v = await createVitest('test', { watch: false, pool, isolate: false, setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'], reporters: [], fileParallelism: false }, {});
const t1 = performance.now();
const [spec0] = await v.globTestSpecifications();
v.provide('tzapMutant', -1);
let r = await v.runTestSpecifications([spec0]);
const t2 = performance.now();
const mod = r.testModules[0];
const tests = [...mod.children.allTests()];
console.log('boot', (t1-t0).toFixed(0), 'first run', (t2-t1).toFixed(0), 'tests', tests.length);
const adds = tests.find(t => t.name === 'adds');
const project = v.getRootProject();
function one(m) {
  v.provide('tzapMutant', m);
  const s = project.createSpecification(spec0.moduleId, { testIds: [adds.id] });
  return v.runTestSpecifications([s]);
}
for (let i=0;i<20;i++) await one(-1);
const N = 200; const times = [];
let lastR;
for (let i = 0; i < N; i++) { const s = performance.now(); lastR = await one(i % 3 === 0 ? 1 : -1); times.push(performance.now() - s); }
times.sort((a,b)=>a-b);
const res = [...lastR.testModules[0].children.allTests()];
const ran = res.filter(t => t.result().state !== 'skipped' && t.result().state !== 'pending');
console.log('rerun median ms', times[N/2].toFixed(2), 'p10', times[N*0.1|0].toFixed(2), 'p90', times[N*0.9|0].toFixed(2));
console.log('ran', ran.map(t => [t.name, t.result().state, JSON.stringify(t.meta())]));
// check kill detection
const k = await one(1); console.log('mutant1 adds:', [...k.testModules[0].children.allTests()].filter(t=>t.name==='adds').map(t=>t.result().state));
const k2 = await one(-1); console.log('no mutant adds:', [...k2.testModules[0].children.allTests()].filter(t=>t.name==='adds').map(t=>t.result().state));
await v.close();
