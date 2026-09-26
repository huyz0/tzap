// Shared helpers for the parity harness: paths, the corpus lock, process spawning, globbing.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const CORPUS = path.join(HERE, 'corpus');
export const RESULTS = path.join(HERE, 'results');
export const REPORTS = path.join(HERE, 'reports');
export const TZAP_BIN = path.join(REPO, 'packages/tzap/dist/bin.js');

export const slash = (p) => p.replace(/\\/g, '/');

export function readYaml(file) {
  return parseYaml(readFileSync(file, 'utf8'));
}

export function loadLock() {
  return readYaml(path.join(HERE, 'corpus.lock'));
}

/** The lock entry for a project, by name or by corpus directory. */
export function projectEntry(nameOrDir) {
  const lock = loadLock();
  const name = existsSync(nameOrDir) ? path.basename(path.resolve(nameOrDir)) : nameOrDir;
  const entry = lock.projects.find((p) => p.name === name);
  if (!entry) throw new Error(`no project '${name}' in corpus.lock (known: ${lock.projects.map((p) => p.name).join(', ')})`);
  return { lock, entry, dir: path.join(CORPUS, entry.name) };
}

/**
 * Runs a command, streaming nothing, capturing both streams. Resolves with
 * { code, stdout, stderr, ms } and never rejects on a non-zero exit.
 */
export function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const useShell = opts.shell ?? process.platform === 'win32';
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    const child = spawn(useShell ? [cmd, ...args].map(quote).join(' ') : cmd, useShell ? [] : args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (opts.echo) process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (opts.echo) process.stderr.write(d);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Math.round(performance.now() - t0) }));
  });
}

/**
 * Python-fnmatch-style glob, used for baseline keys: `*` matches any run of characters
 * (including `/` and `|`), `?` one character, `[...]` a class. Everything else is literal.
 */
export function fnmatch(text, pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const j = pattern.indexOf(']', i + 1);
      // `[]` (an empty class, e.g. the replacement of an ArrayDeclaration) is literal.
      if (j < 0 || j === i + 1) re += '\\[';
      else {
        let body = pattern.slice(i + 1, j);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = j;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(text);
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Vitest config files a project may carry, in Vitest's lookup order. */
export const VITEST_CONFIG_NAMES = ['vitest.config', 'vite.config'].flatMap((b) => ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((e) => `${b}.${e}`));

/**
 * The Vitest config both tools are pointed at. With the A1 workaround on (see corpus.lock
 * `workarounds`), that is the generated wrapper `vitest.parity.config.mjs`.
 */
export function effectiveVitestConfig(lock, p) {
  if (lock.workarounds?.A1) return 'vitest.parity.config.mjs';
  return p.vitestConfig;
}
