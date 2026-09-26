#!/usr/bin/env node
// Materialises corpus projects from corpus.lock into tools/parity/corpus/<name>.
//
//   node fetch.mjs [name ...] [--force] [--check]
//
// Tier A projects are copied from the tzap repository; Tier B projects are cloned and checked
// out at the pinned commit (never a floating ref). Every copy then gets the same overlay:
// package.json devDependencies reduced to what the tests need, Vitest pinned to the lock's
// version (4.1.x: Stryker's Vitest runner is broken on Vitest 5, stryker-js #6210), and
// @stryker-mutator/core + vitest-runner at the lock's Stryker version. Dependencies are
// installed with npm inside the copy, so neither tool's sandbox or install touches the tzap
// workspace. The resolved npm lockfile is saved under locks/ and reused (`npm ci`) next time.
//
// --check runs the project's (parity) Vitest suite once, unmutated, and prints its wall time.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS, HERE, REPO, VITEST_CONFIG_NAMES, effectiveVitestConfig, loadLock, sh } from './lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const check = args.includes('--check');
const names = args.filter((a) => !a.startsWith('--'));
const lock = loadLock();
const selected = names.length ? lock.projects.filter((p) => names.includes(p.name)) : lock.projects;
if (names.length && selected.length !== names.length) {
  console.error(`unknown project(s): ${names.filter((n) => !lock.projects.some((p) => p.name === n)).join(', ')}`);
  process.exit(2);
}

const SKIP_COPY = new Set(['node_modules', 'reports', '.stryker-tmp', '.git', 'dist', 'coverage']);

async function run(cmd, argv, cwd) {
  const r = await sh(cmd, argv, { cwd });
  if (r.code !== 0) throw new Error(`${cmd} ${argv.join(' ')} (in ${cwd}) exited ${r.code}\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
  return r;
}

async function sourceTree(p) {
  if (p.path) return path.resolve(REPO, p.path);
  const src = path.join(CORPUS, '_src', p.name);
  if (!existsSync(path.join(src, '.git'))) {
    mkdirSync(path.dirname(src), { recursive: true });
    await run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', p.git, src], CORPUS);
  }
  await run('git', ['fetch', '--quiet', 'origin', p.commit], src).catch(() => undefined);
  await run('git', ['checkout', '--quiet', '--force', p.commit], src);
  const head = (await run('git', ['rev-parse', 'HEAD'], src)).stdout.trim();
  if (head !== p.commit) throw new Error(`${p.name}: HEAD is ${head}, lock says ${p.commit}`);
  return p.subdir ? path.join(src, p.subdir) : src;
}

function overlayPackageJson(dir, p) {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  delete pkg.packageManager;
  delete pkg.workspaces;
  delete pkg.devEngines;
  // Lifecycle scripts (prepare, postinstall, ...) build or lint; neither tool needs them.
  pkg.scripts = { test: 'vitest run' };
  const keep = p.keepDevDependencies;
  const dev = {};
  for (const [k, v] of Object.entries(pkg.devDependencies ?? {})) {
    if (!keep || keep.includes(k)) dev[k] = v;
  }
  if (p.dropDependencies) for (const k of p.dropDependencies) delete pkg.dependencies?.[k];
  Object.assign(dev, p.addDevDependencies ?? {});
  dev.vitest = p.vitest ?? lock.vitest;
  for (const k of Object.keys(dev)) if (k.startsWith('@vitest/')) dev[k] = p.vitest ?? lock.vitest;
  dev['@stryker-mutator/core'] = lock.stryker;
  dev['@stryker-mutator/vitest-runner'] = lock.stryker;
  pkg.devDependencies = Object.fromEntries(Object.entries(dev).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function materialise(p) {
  const dir = path.join(CORPUS, p.name);
  if (existsSync(path.join(dir, 'node_modules')) && !force) {
    console.log(`${p.name}: present (use --force to rebuild)`);
    return dir;
  }
  const src = await sourceTree(p);
  rmSync(dir, { recursive: true, force: true });
  cpSync(src, dir, {
    recursive: true,
    filter: (f) => !SKIP_COPY.has(path.basename(f)) || f === src,
  });
  for (const lockfile of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', '.yarnrc.yml', '.npmrc', 'pnpm-workspace.yaml']) {
    rmSync(path.join(dir, lockfile), { force: true });
  }
  for (const rm of p.remove ?? []) rmSync(path.join(dir, rm), { recursive: true, force: true });
  overlayPackageJson(dir, p);
  // Vitest looks for a config in parent directories too; a copy without its own config would
  // pick up the tzap workspace's vitest.config.ts (and its `include`). Give it an empty one.
  for (const [rel, content] of Object.entries(p.files ?? {})) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  let baseConfig = p.vitestConfig ?? VITEST_CONFIG_NAMES.find((n) => existsSync(path.join(dir, n)));
  if (!baseConfig) {
    baseConfig = 'vitest.config.mjs';
    writeFileSync(path.join(dir, baseConfig), 'export default {};\n');
  }
  if (lock.workarounds?.A1) {
    // See workarounds/a1-vitest-reporters.mjs. Both tools get this wrapper config.
    cpSync(path.join(HERE, 'workarounds/a1-vitest-reporters.mjs'), path.join(dir, 'parity-a1-vitest-reporters.mjs'));
    writeFileSync(
      path.join(dir, 'vitest.parity.config.mjs'),
      [
        '// Generated by tools/parity/fetch.mjs: the project config plus the A1 workaround plugin.',
        "import { mergeConfig } from 'vitest/config';",
        `import base from './${baseConfig}';`,
        "import a1 from './parity-a1-vitest-reporters.mjs';",
        "export default async (env) => mergeConfig(typeof base === 'function' ? await base(env) : await base, { plugins: [a1()] });",
        '',
      ].join('\n'),
    );
  }
  for (const { file, find, replace } of p.patches ?? []) {
    const f = path.join(dir, file);
    const text = readFileSync(f, 'utf8');
    if (!text.includes(find)) throw new Error(`${p.name}: patch target not found in ${file}: ${find}`);
    writeFileSync(f, text.split(find).join(replace));
  }
  const saved = path.join(HERE, 'locks', `${p.name}.package-lock.json`);
  if (existsSync(saved)) {
    cpSync(saved, path.join(dir, 'package-lock.json'));
    await run('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], dir);
  } else {
    await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], dir);
    mkdirSync(path.dirname(saved), { recursive: true });
    cpSync(path.join(dir, 'package-lock.json'), saved);
  }
  if (p.updateSnapshots) {
    // Snapshots written by an older Vitest differ only in formatting; re-record them once.
    await sh('npx', ['vitest', 'run', '-u', ...(effectiveVitestConfig(lock, p) ? ['--config', effectiveVitestConfig(lock, p)] : [])], { cwd: dir });
  }
  console.log(`${p.name}: materialised at ${dir}`);
  return dir;
}

let failed = false;
for (const p of selected) {
  try {
    const dir = await materialise(p);
    if (check) {
      const argv = ['vitest', 'run', ...(effectiveVitestConfig(lock, p) ? ['--config', effectiveVitestConfig(lock, p)] : [])];
      const r = await sh('npx', argv, { cwd: dir });
      const summary = (r.stdout + r.stderr).split('\n').filter((l) => /Test Files|Tests |Duration/.test(l)).join(' | ');
      console.log(`${p.name}: suite exit ${r.code} in ${r.ms} ms  ${summary.replace(/\x1b\[[0-9;]*m/g, '')}`);
      if (r.code !== 0) failed = true;
    }
  } catch (e) {
    failed = true;
    console.error(`${p.name}: ${e.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
