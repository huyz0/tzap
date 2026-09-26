#!/usr/bin/env node
/**
 * S3 on a real project: the synthetic 10-line PR of bench.mjs, run on a parity corpus project
 * with its whole runtime suite, tzap against StrykerJS. The generated bench fixture's suite takes
 * 0.4 s, so S3 there cannot show what a diff run saves on a suite whose dry run is expensive; this
 * measures that case.
 *
 *   node tools/bench/s3-corpus.mjs [--project remeda] [--runs 3] [--stryker-runs 3]
 *                                  [--stryker-concurrency N] [--out FILE]
 *
 * Prerequisites: `pnpm build`, and the project materialised by tools/parity (`cd tools/parity &&
 * npm ci && node fetch.mjs remeda`), which installs the corpus's pinned Vitest and StrykerJS.
 *
 * Method, as bench.mjs: the patch is derived from the inventory (two files by a fixed stride, five
 * mutant-bearing lines in each) and no figure is recorded when it reaches no mutant; StrykerJS
 * gets `--mutate` ranges for exactly those lines, the best a StrykerJS user can do for a diff;
 * both tools cold, no cache, no incremental; runs interleaved; medians with min–max; StrykerJS at
 * the faster of two concurrencies, chosen by one probe run each; type checking off in both.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const TZAP = path.join(REPO, 'packages', 'tzap', 'dist', 'bin.js');

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const PROJECT = opt('project', 'remeda');
const RUNS = Number(opt('runs', 3));
const STRYKER_RUNS = Number(opt('stryker-runs', 3));
const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform;
const OUT = path.resolve(opt('out', path.join(HERE, 'results', `s3-${PROJECT}-${PLATFORM}.json`)));
const DIR = path.join(REPO, 'tools', 'parity', 'corpus', PROJECT);
const WORK = path.join(os.tmpdir(), `tzap-s3-${PROJECT}`);

/** Per project: the whole runtime suite, and the sources a PR could touch. */
const PROJECTS = {
  remeda: {
    // The project's own `runtime` project, without `isolate: false`: StrykerJS cannot attribute
    // per-test coverage without isolation (see tools/parity/corpus.lock), so both tools run
    // Vitest's default. The `types` and `prop` projects are left out, as in the parity corpus.
    config: `import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: { include: ['src/**/*.test.ts'] },
});
`,
    sources: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts', 'src/**/*.test-d.ts', 'src/**/*.test-prop.ts', 'src/internal/types/**', 'src/index.ts'],
  },
};
const P = PROJECTS[PROJECT];
if (!P) throw new Error(`no S3 settings for ${PROJECT}; known: ${Object.keys(PROJECTS).join(', ')}`);
if (!existsSync(path.join(DIR, 'node_modules', '@stryker-mutator', 'core'))) throw new Error(`${DIR} is not materialised: cd tools/parity && npm ci && node fetch.mjs ${PROJECT}`);

const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
// A plain developer terminal: Vitest switches reporters when it detects an AI agent.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AI_AGENT|CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|CURSOR_AGENT|GEMINI_CLI|AGENT)$/.test(k)));
ENV.NO_COLOR = '1';
ENV.FORCE_COLOR = '0';

function exec(cmd, args, cwd) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, { cwd, env: ENV });
    const lines = [];
    const buf = { out: '', err: '' };
    const take = (k) => (chunk) => {
      buf[k] += chunk.toString();
      let i;
      while ((i = buf[k].indexOf('\n')) >= 0) {
        lines.push({ t: performance.now() - t0, s: buf[k].slice(0, i) });
        buf[k] = buf[k].slice(i + 1);
      }
    };
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    child.on('close', (code) => resolve({ code, ms: performance.now() - t0, lines }));
  });
}
const tail = (r) => r.lines.slice(-30).map((l) => l.s).join('\n');
const count = (ms) => ms.reduce((c, m) => ((c[m.status] = (c[m.status] ?? 0) + 1), c), {});

// --- setup ---------------------------------------------------------------------------------------
mkdirSync(WORK, { recursive: true });
const CONFIG = 'vitest.s3.config.ts';
writeFileSync(path.join(DIR, CONFIG), P.config);
const modelOut = spawnSync(process.execPath, [TZAP, 'model'], { cwd: DIR, encoding: 'utf8', env: ENV });
if (modelOut.status !== 0) throw new Error(`tzap model failed:\n${modelOut.stderr}`);
const model = JSON.parse(modelOut.stdout);
if (model.packages.length !== 1) throw new Error(`expected one package, got ${model.packages.length}`);
Object.assign(model.packages[0], { sources: P.sources, exclude: P.exclude, runner: { ...model.packages[0].runner, config: CONFIG } });
const MODEL = path.join(WORK, 'model.json');
writeFileSync(MODEL, `${JSON.stringify(model, null, 2)}\n`);

const suite = await exec(process.execPath, [path.join(DIR, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', CONFIG], DIR);
if (suite.code !== 0) throw new Error(`the suite is red:\n${tail(suite)}`);
const summary = (re) => suite.lines.find((l) => re.test(l.s))?.s.trim();
log(`suite: ${summary(/Test Files/)}; ${summary(/^\s*Tests /)}; ${(suite.ms / 1000).toFixed(1)} s`);

// --- the patch (bench.mjs's derivation) ------------------------------------------------------------
function inventory(extra = []) {
  const r = spawnSync(process.execPath, [TZAP, 'list-mutants', '-m', MODEL, '--format', 'json', '--no-arid', ...extra], { cwd: DIR, encoding: 'utf8', env: ENV, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`list-mutants failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
function makePatch(inv) {
  const byFile = new Map();
  for (const m of inv) {
    const f = m.file.replace(/\\/g, '/');
    if (!byFile.has(f)) byFile.set(f, new Set());
    byFile.get(f).add(m.location.start.line);
  }
  const files = [...byFile.keys()].sort();
  const chosen = [files[Math.floor(files.length * 0.3)], files[Math.floor(files.length * 0.7)]];
  let diff = '';
  const ranges = [];
  let changed = 0;
  for (const f of chosen) {
    const lines = [...byFile.get(f)].sort((a, b) => a - b);
    const start = Math.floor(lines.length / 3);
    const text = readFileSync(path.join(DIR, f), 'utf8').split('\n');
    const hunks = [];
    for (const l of lines.slice(start, start + 5)) {
      const h = hunks.at(-1);
      if (h && l === h[1] + 1) h[1] = l;
      else hunks.push([l, l]);
    }
    diff += `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n`;
    for (const [a, b] of hunks) {
      const n = b - a + 1;
      diff += `@@ -${a},${n} +${a},${n} @@\n`;
      for (let l = a; l <= b; l++) diff += `-${text[l - 1]} // before\n`;
      for (let l = a; l <= b; l++) diff += `+${text[l - 1]}\n`;
      ranges.push(`${f}:${a}-${b}`);
      changed += n;
    }
  }
  return { diff, ranges, changedLines: changed, files: chosen };
}
const inv = inventory();
const patch = makePatch(inv);
const PATCH = path.join(WORK, 's3.patch');
writeFileSync(PATCH, patch.diff);
const scoped = inventory(['--patch', PATCH]);
const guard = { changedLines: patch.changedLines, files: patch.files, strykerMutate: patch.ranges, mutantsInScope: scoped.length, inventory: inv.length };
log(`patch: ${patch.changedLines} lines in ${patch.files.join(', ')}; ${scoped.length} of ${inv.length} mutants in scope`);
if (scoped.length === 0) throw new Error('the patch reaches no mutant: no figure is recorded');

// --- the tools -----------------------------------------------------------------------------------
async function tzap(i) {
  const out = path.join(WORK, `tzap-${i}`);
  rmSync(out, { recursive: true, force: true });
  const r = await exec(process.execPath, [TZAP, 'run', '-m', MODEL, '--patch', PATCH, '-r', 'json', '-o', out, '--no-arid', '--typecheck', 'off', '-q'], DIR);
  if (r.code !== 0 && r.code !== 1) throw new Error(`tzap exited ${r.code}:\n${tail(r)}`);
  const rep = JSON.parse(readFileSync(path.join(out, 'tzap.json'), 'utf8'));
  return { ms: Math.round(r.ms), phases: rep.timings, inventory: rep.mutants.length, tests: rep.tests?.length, verdicts: count(rep.mutants), mutants: rep.mutants };
}

function strykerConfig(concurrency, report) {
  return {
    packageManager: 'npm',
    testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'],
    vitest: { configFile: CONFIG },
    coverageAnalysis: 'perTest',
    ignoreStatic: false,
    checkers: [],
    reporters: ['json'],
    jsonReporter: { fileName: report },
    mutate: [...P.sources, ...P.exclude.map((g) => `!${g}`)],
    concurrency,
    timeoutMS: 20000,
    timeoutFactor: 1.5,
    incremental: false,
    disableTypeChecks: true,
    cleanTempDir: 'always',
    tempDirName: '.stryker-tmp',
  };
}
async function stryker(concurrency, i) {
  const report = path.join(WORK, `stryker-${i}.json`);
  rmSync(report, { force: true });
  const cfg = 'stryker.s3.config.json';
  writeFileSync(path.join(DIR, cfg), `${JSON.stringify(strykerConfig(concurrency, report), null, 2)}\n`);
  const bin = path.join(DIR, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');
  const r = await exec(process.execPath, [bin, 'run', cfg, '--mutate', patch.ranges.join(',')], DIR);
  if (r.code !== 0 || !existsSync(report)) throw new Error(`stryker exited ${r.code}:\n${tail(r)}`);
  const at = (re) => r.lines.find((l) => re.test(l.s))?.t;
  const dryStart = at(/Starting initial test run/);
  const dryEnd = at(/Initial test run succeeded/);
  const ms = [];
  for (const [file, f] of Object.entries(JSON.parse(readFileSync(report, 'utf8')).files)) for (const m of f.mutants) ms.push({ ...m, file });
  return {
    ms: Math.round(r.ms),
    phases: { beforeDryRun: dryStart && Math.round(dryStart), dryRun: dryStart && dryEnd && Math.round(dryEnd - dryStart), afterDryRun: dryEnd && Math.round(r.ms - dryEnd) },
    inventory: ms.length,
    verdicts: count(ms),
    mutants: ms,
  };
}

// Work parity, as bench.mjs: StrykerJS's incremental key with the replacement normalised.
const norm = (s) => String(s).replace(/[\s()]/g, '').replace(/"/g, "'");
const key = (m) => `${m.file.replace(/\\/g, '/').replace(/^.*?\bsrc\//, 'src/')}:${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column} ${m.mutatorName} ${norm(m.replacement)}`;
function parity(a, b) {
  const A = new Map(a.map((m) => [key(m), m]));
  const B = new Map(b.map((m) => [key(m), m]));
  const shared = [...A.keys()].filter((k) => B.has(k));
  const disagree = {};
  for (const k of shared) {
    const x = A.get(k).status, y = B.get(k).status;
    if (x !== y) disagree[`${x}/${y}`] = (disagree[`${x}/${y}`] ?? 0) + 1;
  }
  return { shared: shared.length, tzapOnly: a.length - shared.length, strykerOnly: b.length - shared.length, disagree };
}

// --- run -----------------------------------------------------------------------------------------
let concurrency = opt('stryker-concurrency') ? Number(opt('stryker-concurrency')) : undefined;
const probe = [];
if (concurrency === undefined) {
  for (const c of [...new Set([2, os.availableParallelism()])]) {
    const r = await stryker(c, `probe-${c}`);
    log(`stryker concurrency probe c=${c}: ${(r.ms / 1000).toFixed(2)} s`);
    probe.push({ concurrency: c, ms: r.ms });
  }
  concurrency = probe.reduce((a, b) => (b.ms < a.ms ? b : a)).concurrency;
}

const T = [], S = [];
for (let i = 0; i < Math.max(RUNS, STRYKER_RUNS); i++) {
  if (i < RUNS) {
    const r = await tzap(i);
    T.push(r);
    log(`tzap ${i + 1}/${RUNS}: ${(r.ms / 1000).toFixed(2)} s inv=${r.inventory} ${JSON.stringify(r.verdicts)} ${JSON.stringify(r.phases)}`);
  }
  if (i < STRYKER_RUNS) {
    const r = await stryker(concurrency, i);
    S.push(r);
    log(`stryker ${i + 1}/${STRYKER_RUNS}: ${(r.ms / 1000).toFixed(2)} s inv=${r.inventory} ${JSON.stringify(r.verdicts)} ${JSON.stringify(r.phases)}`);
  }
}
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stat = (runs) => ({ median: med(runs.map((r) => r.ms)), min: Math.min(...runs.map((r) => r.ms)), max: Math.max(...runs.map((r) => r.ms)) });
const strip = ({ mutants, ...rest }) => rest;
const result = {
  project: PROJECT,
  machine: { platform: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model.trim(), logicalCpus: os.availableParallelism(), node: process.version, date: new Date().toISOString(), tzapCommit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() },
  suite: { files: summary(/Test Files/), tests: summary(/^\s*Tests /), ms: Math.round(suite.ms) },
  guard,
  strykerConcurrency: concurrency,
  strykerProbe: probe,
  tzap: { ...stat(T), runs: T.map(strip) },
  stryker: { ...stat(S), runs: S.map(strip) },
  ratio: Math.round((stat(S).median / stat(T).median) * 10) / 10,
  parity: parity(T.at(-1).mutants, S.at(-1).mutants),
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(path.join(path.dirname(OUT), `S3-${PROJECT}.patch`), patch.diff);
log(`S3 on ${PROJECT}: tzap ${(result.tzap.median / 1000).toFixed(2)} s, StrykerJS ${(result.stryker.median / 1000).toFixed(2)} s (concurrency ${concurrency}): ${result.ratio}x`);
log(`parity: ${JSON.stringify(result.parity)}; written to ${path.relative(REPO, OUT)}`);
for (const f of [CONFIG, 'stryker.s3.config.json']) rmSync(path.join(DIR, f), { force: true });
