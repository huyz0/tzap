// Keeps files and folders small enough to read: no tracked source or doc file over MAX_LINES
// lines, and no folder holding more than MAX_ENTRIES files. Checked over what git tracks, so
// build output and installed dependencies never count.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const MAX_LINES = 700;
const MAX_ENTRIES = 20;
const CHECKED = /\.(ts|cts|mts|js|cjs|mjs|vue|svelte|md)$/;
// Third-party sources checked out for the parity runs.
const VENDORED = /^tools\/parity\/corpus\//;
/**
 * The benchmark fixture is generated (tools/bench/generate.mjs) to have the shape of a flat module
 * folder of a real project, 40 modules and their test files; its size is the point.
 */
const GENERATED = /^fixtures\/bench-vitest\//;

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f !== '' && !VENDORED.test(f) && !f.includes('/node_modules/'));

const problems = [];
const perFolder = new Map();
for (const f of files) {
  if (!GENERATED.test(f)) perFolder.set(path.posix.dirname(f), (perFolder.get(path.posix.dirname(f)) ?? 0) + 1);
  if (!CHECKED.test(f)) continue;
  let text;
  try {
    text = readFileSync(path.join(root, f), 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > MAX_LINES) problems.push(`${f}: ${lines} lines (at most ${MAX_LINES})`);
}
for (const [dir, n] of perFolder) if (n > MAX_ENTRIES) problems.push(`${dir}/: ${n} files (at most ${MAX_ENTRIES})`);

if (problems.length > 0) {
  console.error(`size check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`sizes hold: ${files.length} files, none over ${MAX_LINES} lines, no folder over ${MAX_ENTRIES} files`);
