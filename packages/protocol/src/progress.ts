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
  return (runId, test, mutant, done) => {
    const line = `${runId}\t${mutant}\t${done ? 1 : 0}\t${test}\n`.padEnd(200, ' ');
    try {
      writeSync(fd, line, 0);
    } catch {
      closeSync(fd);
    }
  };
}

/** On the engine side: every worker's latest entry. */
export function readProgress(dir: string): ProgressEntry[] {
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
      const [runId, mutant, done, ...test] = readFileSync(f, 'utf8').trimEnd().split('\t');
      out.push({ runId: Number(runId), mutant: Number(mutant), done: done === '1', test: test.join('\t'), at: statSync(f).mtimeMs });
    } catch {
      // A file being rewritten this instant is read again on the next poll.
    }
  }
  return out;
}
