// Compares two tzap JSON reports mutant by mutant; exits 1 on any verdict difference.
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const key = (m) => `${m.file}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName} ${m.replacement}`;
const A = new Map(a.mutants.map((m) => [key(m), m]));
const B = new Map(b.mutants.map((m) => [key(m), m]));
let diff = 0;
for (const [k, m] of A) {
  const o = B.get(k);
  if (!o || o.status !== m.status) {
    diff++;
    console.log(`DIFF ${k}\n  A ${m.status} ${m.statusReason?.slice(0, 80) ?? ''}\n  B ${o?.status} ${o?.statusReason?.slice(0, 80) ?? ''}`);
  }
}
for (const k of B.keys()) if (!A.has(k)) { diff++; console.log(`ONLY-B ${k}`); }
const count = (r) => r.mutants.reduce((c, m) => ((c[m.status] = (c[m.status] ?? 0) + 1), c), {});
console.log('A', JSON.stringify(count(a)), '\nB', JSON.stringify(count(b)), `\n${A.size} mutants, ${diff} differences`);
process.exitCode = diff ? 1 : 0;
