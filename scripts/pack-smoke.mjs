// The test that catches a broken `files` list, a missing dependency or a bundling mistake: pack
// the publishable package, install the tarball into a fresh project outside this repository,
// and run it the way a user would.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', shell: process.platform === 'win32' });

run('node', [path.join(root, 'scripts', 'bundle.mjs')], root);
const pkgDir = path.join(root, 'dist-npm', 'tzap');
const packDir = mkdtempSync(path.join(os.tmpdir(), 'tzap-pack-'));
run('npm', ['pack', '--pack-destination', packDir], pkgDir);
const tarball = path.join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz')));

const projects = [];
/** Copies a fixture outside the repository and installs the packed tarball (and extra packages) into it. */
function setUp(fixture, extra) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tzap-smoke-'));
  projects.push(dir);
  cpSync(path.join(root, 'fixtures', fixture), dir, { recursive: true, filter: (s) => !s.includes('node_modules') });
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: pkg.type ?? 'module', scripts: pkg.scripts }));
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...extra, tarball], dir);
  return dir;
}
const expected = 'tzap: 6 survived, 3 uncovered of 37 mutants (score 75.7%, strength 82.4%)';
try {
  // SMOKE_ONLY=sample-node checks one fixture.
  const only = process.env.SMOKE_ONLY?.split(',');
  for (const [fixture, extra] of [['sample-vitest', ['vitest@5.0.2']], ['sample-node', []], ['sample-mocha', ['mocha@12.0.2']]]) {
    if (only && !only.includes(fixture)) continue;
    const dir = setUp(fixture, extra);
    const out = run('npx', ['tzap', 'run', '-q', '-r', 'agent'], dir);
    const first = out.split('\n')[0];
    if (first !== expected) throw new Error(`unexpected result from the installed package on ${fixture}:\n${out}`);
    console.log(`${fixture}: ${first}`);
  }
  if (projects.length) console.log(`installed tzap ${run('npx', ['tzap', '--version'], projects[0]).trim()} from ${path.basename(tarball)}`);
} finally {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
}
