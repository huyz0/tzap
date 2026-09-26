#!/usr/bin/env node
// Runs StrykerJS and tzap over one corpus project, twice each, at the pinned configuration
// from docs/parity-and-benchmarks.md §1.
//
//   node run.mjs <project-dir | name> [--runs N] [--engine warm|reference] [--only stryker|tzap]
//                                     [--concurrency N] [--timeout-ms N]
//
// Stryker: @stryker-mutator/core + vitest-runner at the lock's version, installed in the corpus
// copy; coverageAnalysis perTest, ignoreStatic false, no testFiles, checkers [], reporters
// [json], concurrency <= half the physical cores, generous timeoutMS, incremental off.
// tzap: `tzap run -r json,elements --no-arid` with a project model whose sources are the same
// globs Stryker mutates, and the same worker count.
//
// Runs alternate order (S,T then T,S) to spread the ordering effect. Outputs, per run:
//   results/<name>/stryker-<i>/mutation.json, stryker.log
//   results/<name>/tzap-<engine>-<i>/mutation.json, tzap.json, tzap.log
//   results/<name>/runs.json  (wall clock and exit code of every run)
import { cpus } from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RESULTS, TZAP_BIN, effectiveVitestConfig, projectEntry, sh, slash } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const target = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!target) {
  console.error('usage: node run.mjs <project-dir | name> [--runs N] [--engine warm|reference] [--only stryker|tzap]');
  process.exit(2);
}
const { lock, entry: p, dir } = projectEntry(target);
if (!existsSync(path.join(dir, 'node_modules'))) {
  console.error(`${dir} is not materialised; run: node fetch.mjs ${p.name}`);
  process.exit(2);
}
const vitestConfig = effectiveVitestConfig(lock, p);
const runs = Number(opt('runs', 2));
const engine = opt('engine', 'warm');
const only = opt('only', undefined);

async function physicalCores() {
  if (process.platform === 'win32') {
    const r = await sh('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum']);
    const n = Number(r.stdout.trim());
    if (n > 0) return n;
  }
  return Math.max(1, Math.floor(cpus().length / 2));
}
const concurrency = Number(opt('concurrency', 0)) || Math.max(1, Math.floor((await physicalCores()) / 2));
const timeoutMS = Number(opt('timeout-ms', 0)) || p.timeoutMS || 20000;

const out = path.join(RESULTS, p.name);
mkdirSync(out, { recursive: true });

// ---- Stryker configuration (checked into the results for rerunnability) ----
const strykerConfig = (reportFile) => ({
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  packageManager: 'npm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  coverageAnalysis: 'perTest',
  ignoreStatic: false,
  checkers: [],
  reporters: ['json'],
  jsonReporter: { fileName: slash(reportFile) },
  mutate: [...p.mutate, ...(p.exclude ?? []).map((g) => `!${g}`)],
  concurrency,
  timeoutMS,
  timeoutFactor: 1.5,
  incremental: false,
  disableTypeChecks: true,
  cleanTempDir: 'always',
  tempDirName: '.stryker-tmp',
  logLevel: 'info',
  ...(vitestConfig ? { vitest: { configFile: vitestConfig } } : {}),
  ...(p.strykerOptions ?? {}),
});

// ---- tzap project model: same sources as Stryker's `mutate` ----
async function tzapModel() {
  const r = await sh('node', [TZAP_BIN, 'model'], { cwd: dir });
  if (r.code !== 0) throw new Error(`tzap model failed:\n${r.stderr}`);
  const model = JSON.parse(r.stdout);
  if (model.packages.length !== 1) throw new Error(`expected one package, got ${model.packages.length}`);
  const pkg = model.packages[0];
  pkg.sources = [...p.mutate];
  pkg.exclude = [...(p.exclude ?? [])];
  if (vitestConfig) pkg.runner = { ...pkg.runner, config: vitestConfig };
  const file = path.join(out, 'tzap-model.json');
  writeFileSync(file, `${JSON.stringify(model, null, 2)}\n`);
  return file;
}

async function runStryker(i) {
  const runDir = path.join(out, `stryker-${i}`);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const report = path.join(runDir, 'mutation.json');
  const configFile = path.join(dir, 'stryker.parity.config.json');
  const config = strykerConfig(report);
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(path.join(runDir, 'stryker.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const r = await sh('npx', ['stryker', 'run', 'stryker.parity.config.json'], { cwd: dir });
  writeFileSync(path.join(runDir, 'stryker.log'), r.stdout + r.stderr);
  const ok = existsSync(report);
  console.log(`  stryker run ${i}: exit ${r.code} in ${(r.ms / 1000).toFixed(1)} s${ok ? '' : '  (NO REPORT)'}`);
  return { tool: 'stryker', run: i, ms: r.ms, code: r.code, report: ok ? slash(path.relative(out, report)) : null };
}

async function runTzap(i, modelFile) {
  const runDir = path.join(out, `tzap-${engine}-${i}`);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const args = [TZAP_BIN, 'run', '-m', modelFile, '-r', 'json,elements', '-o', runDir, '--no-arid', '--typecheck', 'off', '--engine', engine, '--workers', String(concurrency)];
  const r = await sh('node', args, { cwd: dir });
  writeFileSync(path.join(runDir, 'tzap.log'), `$ node ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  const report = path.join(runDir, 'mutation.json');
  const ok = existsSync(report);
  console.log(`  tzap (${engine}) run ${i}: exit ${r.code} in ${(r.ms / 1000).toFixed(1)} s${ok ? '' : '  (NO REPORT)'}`);
  return { tool: `tzap-${engine}`, run: i, ms: r.ms, code: r.code, report: ok ? slash(path.relative(out, report)) : null };
}

const vitestVersion = JSON.parse(readFileSync(path.join(dir, 'node_modules/vitest/package.json'), 'utf8')).version;
const strykerVersion = JSON.parse(readFileSync(path.join(dir, 'node_modules/@stryker-mutator/core/package.json'), 'utf8')).version;
console.log(`${p.name}: vitest ${vitestVersion}, stryker ${strykerVersion}, node ${process.version}, concurrency ${concurrency}, timeoutMS ${timeoutMS}`);

const modelFile = await tzapModel();
const runsFile = path.join(out, 'runs.json');
const previous = existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, 'utf8')) : { runs: [] };
const results = previous.runs.filter((r) => !(r.tool === 'stryker' && only !== 'tzap') && !(r.tool === `tzap-${engine}` && only !== 'stryker'));
for (let i = 1; i <= runs; i++) {
  const order = i % 2 === 1 ? ['stryker', 'tzap'] : ['tzap', 'stryker'];
  for (const tool of order) {
    if (only && only !== tool) continue;
    results.push(tool === 'stryker' ? await runStryker(i) : await runTzap(i, modelFile));
  }
}
rmSync(path.join(dir, 'stryker.parity.config.json'), { force: true });
writeFileSync(
  runsFile,
  `${JSON.stringify({ project: p.name, commit: p.commit ?? null, vitest: vitestVersion, stryker: strykerVersion, node: process.version, concurrency, timeoutMS, runs: results }, null, 2)}\n`,
);
if (results.some((r) => !r.report)) process.exitCode = 1;
