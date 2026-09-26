// Full analyse() on fixtures/sample-jest with the Jest adapter: node spike/analyse.mjs [warm|reference]
import path from 'node:path';
import { analyse } from '@tzap/core';
import { createJestSession } from '../dist/index.js';

const root = path.resolve(import.meta.dirname, '../../../fixtures/sample-jest').split(path.sep).join('/');
const engine = process.argv[2] ?? 'warm';
const model = { schemaVersion: 1, root, packages: [{ id: 'sample-jest', root: '.', sources: ['src/**/*.ts'], runner: { kind: 'jest' } }] };
const t = performance.now();
const r = await analyse(model, {
  engine,
  runners: { jest: createJestSession },
  tzapVersion: '0.0.0',
  onEvent: (e) => process.env.V && console.error(JSON.stringify(e)),
});
const ms = performance.now() - t;
if (process.env.V) {
  for (const m of r.mutants) console.log(m.file, JSON.stringify(m.location ?? m.line), m.mutatorName ?? m.mutator, JSON.stringify(m.replacement), m.status, m.killedBy?.join(',') ?? '', m.statusReason ?? '');
}
const counts = {};
for (const m of r.mutants) counts[m.status] = (counts[m.status] ?? 0) + 1;
console.log(JSON.stringify({ engine, ms: Math.round(ms), counts, timings: r.timings }));
