// The test that catches a broken `files` list, a missing dependency or a bundling mistake: pack
// the publishable package, install the tarball into a fresh project outside this repository,
// and run it the way a user would.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', shell: process.platform === 'win32' });

run('node', [path.join(root, 'scripts', 'bundle.mjs')], root);
const pkgDir = path.join(root, 'dist-npm', 'tzap');
const packDir = mkdtempSync(path.join(os.tmpdir(), 'tzap-pack-'));
run('npm', ['pack', '--pack-destination', packDir], pkgDir);
const tarball = path.join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz')));

const project = mkdtempSync(path.join(os.tmpdir(), 'tzap-smoke-'));
cpSync(path.join(root, 'fixtures', 'sample-vitest'), project, { recursive: true, filter: (s) => !s.includes('node_modules') });
writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
try {
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', 'vitest@5.0.2', tarball], project);
  const version = run('npx', ['tzap', '--version'], project).trim();
  const out = run('npx', ['tzap', 'run', '-q', '-r', 'agent'], project);
  const first = out.split('\n')[0];
  const expected = 'tzap: 6 survived, 3 uncovered of 37 mutants (score 75.7%, strength 82.4%)';
  if (first !== expected) throw new Error(`unexpected result from the installed package:\n${out}`);
  console.log(`installed tzap ${version} from ${path.basename(tarball)} and ran it: ${first}`);
} finally {
  rmSync(project, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
}
