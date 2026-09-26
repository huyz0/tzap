import { instrument, parse } from '../../packages/instrument/dist/index.js';
import { globSync } from '../../packages/core/node_modules/tinyglobby/dist/index.mjs';
import { readFileSync } from 'node:fs';
const dirs = process.argv.slice(2);
let dropped = 0, files = 0, mutants = 0, bad = 0, parseFail = 0, ms = 0, bytes = 0;
for (const d of dirs) for (const f of globSync(['**/*.{js,mjs,cjs,ts,tsx}'], { cwd: d, absolute: true, ignore: ['**/*.d.ts','**/*.d.mts','**/*.d.cts'] })) {
  const src = readFileSync(f, 'utf8'); if (src.length > 3_000_000) continue;
  const t = performance.now();
  let out;
  try { out = instrument({ file: f, source: src, firstMutant: 0, firstSite: 0 }); } catch (e) { bad++; console.log('THROW', f, e.message.slice(0,200)); continue; }
  ms += performance.now() - t; bytes += src.length;
  if (out.errors.length) { parseFail++; continue; }
  files++; mutants += out.mutants.length; dropped += out.mutants.filter((m) => m.ignoredBy === 'placement').length;
  if (out.code) { const p = parse(f, out.code); if (p.errors.length) { bad++; if (bad < 8) console.log('BROKEN', f, p.errors[0]); } }
}
console.log({ files, mutants, dropped, bad, parseFail, ms: Math.round(ms), MB: (bytes/1e6).toFixed(1) });
