import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { ProgressEntry } from './index.js';

/** In a runner worker: a writer that overwrites this worker's progress file, or undefined without a directory. */
export function progressWriter(dir: string | undefined, id: string): ((runId: number, test: string, mutant: number, done: boolean) => void) | undefined {
  if (!dir) return undefined;
  let fd: number;
  try {
    mkdirSync(dir, { recursive: true });
    fd = openSync(path.join(dir, `${id}.progress`), 'w');
  } catch {
    return undefined;
  }
  // Each entry overwrites the last in place, padded with spaces to the longest entry so far: the
  // file is never truncated, so a reader polling it sees one whole entry, never a mix of two.
  let width = 200;
  let open = true;
  return (runId, test, mutant, done) => {
    if (!open) return;
    const bytes = Buffer.from(`${runId}\t${mutant}\t${done ? 1 : 0}\t${test}\n`);
    width = Math.max(width, bytes.length);
    const line = Buffer.alloc(width, ' ');
    bytes.copy(line);
    try {
      writeSync(fd, line, 0, width, 0);
    } catch {
      // Progress is advisory: a worker that cannot write it runs on without it.
      open = false;
      try {
        closeSync(fd);
      } catch {
        // already unusable
      }
    }
  };
}

/**
 * On the engine side: every worker's latest entry. With `since`, files not written since then
 * (workers of earlier runs) are passed over after a stat, not read.
 */
export function readProgress(dir: string, since = 0): ProgressEntry[] {
  const out: ProgressEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith('.progress')) continue;
    const f = path.join(dir, n);
    try {
      const at = statSync(f).mtimeMs;
      if (at < since) continue;
      const [runId, mutant, done, ...test] = readFileSync(f, 'utf8').trimEnd().split('\t');
      out.push({ runId: Number(runId), mutant: Number(mutant), done: done === '1', test: test.join('\t'), at });
    } catch {
      // A file being rewritten this instant is read again on the next poll.
    }
  }
  return out;
}
