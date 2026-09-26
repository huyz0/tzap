#!/usr/bin/env node
/**
 * Coverage of the whole test suite, from NODE_V8_COVERAGE in every process and thread: Vitest's
 * workers (each test file writes its coverage when it ends, see coverage-setup.mjs), and the
 * processes tzap starts itself — the runner hosts, and the setup files and environments they load
 * into the user's test runner. c8 maps it all back to src.
 *
 *   node scripts/coverage.mjs [--threshold 95]
 *
 * Needs a build first (`pnpm build`): the child processes run packages' dist, mapped to src by
 * the source maps. Writes coverage/merged (text summary on stdout, HTML in coverage/merged/html).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'coverage');
const argv = process.argv.slice(2);
const threshold = argv.includes('--threshold') ? Number(argv[argv.indexOf('--threshold') + 1]) : undefined;
if (threshold !== undefined && !(threshold >= 0 && threshold <= 100)) {
  console.error('--threshold: expected a percentage from 0 to 100');
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'tmp'), { recursive: true });

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(
  process.execPath,
  [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'scripts/vitest.coverage.config.ts')],
  // Source maps let c8 map what Vite transformed back to the files it came from.
  { NODE_V8_COVERAGE: path.join(out, 'tmp'), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --enable-source-maps`.trim() },
);
run(process.execPath, [path.join(root, 'node_modules/c8/bin/c8.js'), 'report', '--reporter=json', '--reports-dir=coverage/c8']);

const map = libCoverage.createCoverageMap({});
map.merge(JSON.parse(readFileSync(path.join(out, 'c8', 'coverage-final.json'), 'utf8')));
const context = libReport.createContext({ dir: path.join(out, 'merged'), coverageMap: map });
for (const r of ['text', 'text-summary', 'json-summary']) reports.create(r).execute(context);
reports.create('html', { subdir: 'html' }).execute(context);

if (threshold !== undefined) {
  const s = map.getCoverageSummary();
  const low = ['statements', 'branches', 'functions', 'lines'].filter((k) => s[k].pct < threshold);
  if (low.length) {
    console.error(`coverage below ${threshold}%: ${low.map((k) => `${k} ${s[k].pct}%`).join(', ')}`);
    process.exit(1);
  }
}
