#!/usr/bin/env node
/**
 * Coverage of the whole test suite, in one model from two sources:
 *
 * - Vitest's V8 provider for the test workers, which maps what Vite transformed back to src.
 * - NODE_V8_COVERAGE for the processes tzap starts itself (the runner hosts, and the setup files
 *   and environments they load into the user's test runner). They run packages' dist; each script
 *   is mapped back to src through the source map next to it, by the same AST-aware converter the
 *   V8 provider uses.
 *
 *   node scripts/coverage.mjs [--threshold 95]
 *
 * --threshold gates line coverage. Lines are what the two sources agree on: a line is covered when
 * either side ran it. Statements and branches are reported but not gated, as the code Vite runs and
 * the code tsc emits for the same source delimit them differently, and a statement one side shapes
 * differently from the other is counted twice.
 *
 * Needs a build first (`pnpm build`). Writes coverage/merged (text summary on stdout, HTML in
 * coverage/merged/html).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from 'ast-v8-to-istanbul';
import { parseSync } from 'oxc-parser';

const require = createRequire(import.meta.url);
const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'coverage');
const raw = path.join(out, 'raw');
const argv = process.argv.slice(2);
const threshold = argv.includes('--threshold') ? Number(argv[argv.indexOf('--threshold') + 1]) : undefined;
if (threshold !== undefined && !(threshold >= 0 && threshold <= 100)) {
  console.error('--threshold: expected a percentage from 0 to 100');
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });

const vitest = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--coverage.enabled',
    '--coverage.provider=v8',
    '--coverage.reporter=json',
    '--coverage.reportsDirectory=coverage/vitest',
    '--coverage.include=packages/*/src/**',
    // Runner tests load their package's dist, which maps back to src.
    '--coverage.include=packages/*/dist/**',
    '--coverage.excludeAfterRemap',
    // CommonJS TypeScript runs only in the runner processes, below.
    '--coverage.exclude=**/*.cts',
    '--coverage.exclude=**/*.d.ts',
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: raw } },
);
if (vitest.status !== 0) process.exit(vitest.status ?? 1);

const map = libCoverage.createCoverageMap(JSON.parse(readFileSync(path.join(out, 'vitest', 'coverage-final.json'), 'utf8')));
const DIST = /[\\/]packages[\\/][^\\/]+[\\/]dist[\\/].*\.c?js$/;
const parsed = new Map();
for (const dump of readdirSync(raw)) {
  const { result } = JSON.parse(readFileSync(path.join(raw, dump), 'utf8'));
  for (const script of result) {
    if (!script.url.startsWith('file:')) continue;
    const file = fileURLToPath(script.url);
    if (!DIST.test(file) || !existsSync(`${file}.map`)) continue;
    let p = parsed.get(file);
    if (!p) {
      const code = readFileSync(file, 'utf8');
      p = { code, sourceMap: JSON.parse(readFileSync(`${file}.map`, 'utf8')), program: parseSync(file, code).program };
      parsed.set(file, p);
    }
    // Node compiles CommonJS without a textual wrapper: offsets are the file's own either way.
    map.merge(await convert({ code: p.code, sourceMap: p.sourceMap, ast: p.program, coverage: script, wrapperLength: 0 }));
  }
}

// A module of types only compiles to nothing that runs, and is never loaded.
map.filter((file) => !typesOnly(file));

const context = libReport.createContext({ dir: path.join(out, 'merged'), coverageMap: map });
for (const r of ['text', 'text-summary', 'json-summary', 'json']) reports.create(r).execute(context);
reports.create('html', { subdir: 'html' }).execute(context);

const lines = map.getCoverageSummary().lines.pct;
if (threshold !== undefined && lines < threshold) {
  console.error(`line coverage ${lines}% is below ${threshold}%`);
  process.exit(1);
}

/** Whether the compiled output of a package's src file holds no runtime code. */
function typesOnly(file) {
  const m = /^(.*[\\/]packages[\\/][^\\/]+[\\/])src([\\/].*)\.([cm]?)ts$/.exec(file);
  if (!m) return false;
  let js;
  try {
    js = readFileSync(`${m[1]}dist${m[2]}.${m[3]}js`, 'utf8');
  } catch {
    return false;
  }
  const code = js.split('\n').filter((l) => !/^(\/\/# sourceMappingURL=.*|export \{\};|"use strict";|Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);|\s*)$/.test(l));
  return code.length === 0;
}
