/**
 * Resolves "what changed" into the lines that are in scope for a diff-scoped run.
 *
 * Two sources: the git CLI (`gitChangedLines`) and a unified diff with no repository at all
 * (`parseUnifiedDiff`), which is what CI systems that hand over a patch use and what lets the core
 * stay independent of git. Both produce the same {@link ChangedLines}.
 *
 * The range only SELECTS: analysis always runs against the working tree, and nothing is checked
 * out. Pointing `from`/`to` at old commits whose files have since changed selects lines that no
 * longer describe those commits.
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 1-based inclusive line range on the new (`to`) side. */
export type LineRange = readonly [start: number, end: number];

export interface ChangedLines {
  /** Paths relative to the requested root, forward slashes; ranges sorted and merged. */
  files: Map<string, LineRange[]>;
  /** Human-readable summary, e.g. "changes from HEAD to the working tree (3 files, 12 lines)". */
  description: string;
}

export class GitScopeError extends Error {
  override name = 'GitScopeError';
}

/** Uncommitted work: staged, unstaged and untracked files together. */
export const LOCAL = '-Local-';
/** The empty tree as `from`: every line of every file at `to` is changed. */
export const EMPTY = '-Empty-';

// ---------------------------------------------------------------------------------------------
// Patch parsing

export interface ParseOptions {
  /**
   * Directory, relative to the patch's paths, to report paths against; files outside it are
   * dropped. Omitted or "." keeps every path as written.
   */
  root?: string;
  /**
   * Leading path components to strip, as `patch -pN`. Omitted: strip a git-style `a/` or `b/`
   * prefix when present, otherwise keep the path (a `diff -u` patch has no prefix).
   */
  stripPrefix?: number;
  /**
   * New-side length of a file, used to clamp a pure deletion at end of file in a zero-context
   * patch, where the patch alone cannot tell the deletion was at the end. Patches with context
   * do not need it: a deletion that is not at end of file always has trailing context.
   */
  lineCount?: (path: string) => number | undefined;
}

type Acc = Map<string, [number, number][]>;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patch: string, opts: ParseOptions = {}): ChangedLines {
  const acc: Acc = new Map();
  parseInto(patch, acc, opts, false);
  const files = finish(acc, opts.root);
  return { files, description: `changes in the patch (${summary(files)})` };
}

/**
 * @param contextAtLeastOne the patch was produced with at least one context line (git mode uses
 *   -U1), so a deletion run that ends a hunk is known to be at end of file even with no context
 *   lines in that hunk (a file emptied entirely).
 */
function parseInto(patch: string, acc: Acc, opts: ParseOptions, contextAtLeastOne: boolean): void {
  const add = (path: string, start: number, end = start) => {
    let r = acc.get(path);
    if (!r) acc.set(path, (r = []));
    r.push([start, end]);
  };
  let path: string | null = null;
  let oldLeft = 0, newLeft = 0, newLine = 0;
  let inHunk = false, hunkHasContext = false, runDel = false, runAdd = false;

  // A run is a maximal sequence of -/+ lines. Only a run of removals with nothing added is a
  // pure deletion; it marks the line now sitting at the deletion point, so deleting a guard
  // clause still selects the code it guarded (cargo-mutants does the same).
  const closeRun = (atHunkEnd: boolean) => {
    if (path !== null && runDel && !runAdd) {
      if (!atHunkEnd) add(path, newLine);
      else if (hunkHasContext || contextAtLeastOne) {
        // Nothing follows the deletion in the new file: it was at end of file, so the nearest
        // surviving line is the one before it (none if the file is now empty).
        if (newLine - 1 >= 1) add(path, newLine - 1);
      } else {
        const n = opts.lineCount?.(path);
        const line = n === undefined ? newLine : Math.min(newLine, n);
        if (line >= 1) add(path, line);
      }
    }
    runDel = runAdd = false;
  };

  for (const line of patch.split(/\r?\n/)) {
    if (!inHunk) {
      // Between hunks, where headers are the only lines that mean anything. Inside a hunk
      // every line is content, and content can look like anything: an added line "++ i;" reads
      // "+++ i;" in the patch. Hunk bounds come from the header counts, never from prefixes.
      if (line.startsWith('+++ ')) path = patchPath(line.slice(4), opts.stripPrefix);
      else if (line.startsWith('diff ') || line.startsWith('--- ')) path = null; // new file section
      else {
        const m = HUNK.exec(line);
        if (m) {
          oldLeft = m[2] === undefined ? 1 : +m[2];
          newLeft = m[4] === undefined ? 1 : +m[4];
          // With a new-side count of 0 the start names the line BEFORE the hunk position.
          newLine = newLeft === 0 ? +m[3]! + 1 : +m[3]!;
          inHunk = oldLeft > 0 || newLeft > 0;
          hunkHasContext = runDel = runAdd = false;
        }
      }
      continue;
    }
    // "\ No newline at end of file" qualifies the line before it; it belongs to neither file.
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      if (path !== null) add(path, newLine);
      newLine++, newLeft--, (runAdd = true);
    } else if (line.startsWith('-')) {
      oldLeft--, (runDel = true);
    } else {
      // Context. A bare empty line is what trailing-whitespace stripping (or
      // diff.suppressBlankEmpty) leaves of a blank context line; it still counts on both sides.
      closeRun(false);
      newLine++, newLeft--, oldLeft--, (hunkHasContext = true);
    }
    if (oldLeft <= 0 && newLeft <= 0) closeRun(true), (inHunk = false);
  }
}

/** The path from a `+++ ` header: C-quoted, or up to a tab (git adds one after names with spaces; `diff -u` puts the timestamp there). */
function patchPath(raw: string, strip: number | undefined): string | null {
  let p: string;
  if (raw.startsWith('"')) p = unquote(raw);
  else {
    const tab = raw.indexOf('\t');
    // Backslashes only reach an unquoted path from a non-git tool on Windows; git quotes them.
    p = (tab >= 0 ? raw.slice(0, tab) : raw.trimEnd()).replace(/\\/g, '/');
  }
  if (p === '/dev/null') return null; // deleted file: nothing left to mutate
  if (strip === undefined) {
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  } else if (strip > 0) {
    const parts = p.split('/').filter((s, i) => s !== '' || i === 0);
    if (parts.length <= strip) return null;
    p = parts.slice(strip).join('/');
  }
  return p.replace(/^(\.\/)+/, '');
}

/** Decodes git's C-style quoting (`core.quotePath`): escapes and octal UTF-8 bytes. */
function unquote(q: string): string {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < q.length; i++) {
    const c = q[i]!;
    if (c === '"') break;
    if (c !== '\\') { bytes.push(...enc.encode(c)); continue; }
    const n = q[++i] ?? '';
    if (/[0-7]/.test(n)) {
      const oct = /^[0-7]{1,3}/.exec(q.slice(i))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length - 1;
    } else bytes.push(simple[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Sorts, merges and re-roots the accumulated ranges. */
function finish(acc: Acc, root: string | undefined): Map<string, LineRange[]> {
  const prefix = (root ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const out = new Map<string, LineRange[]>();
  for (const [p, ranges] of [...acc].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let rel = p;
    if (prefix !== '' && prefix !== '.') {
      if (!p.startsWith(prefix + '/')) continue;
      rel = p.slice(prefix.length + 1);
    }
    const merged: [number, number][] = [];
    for (const [s, e] of ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    if (merged.length) out.set(rel, merged);
  }
  return out;
}

function summary(files: Map<string, LineRange[]>): string {
  let lines = 0;
  for (const r of files.values()) for (const [s, e] of r) lines += e - s + 1;
  const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return `${pl(files.size, 'file')}, ${pl(lines, 'line')}`;
}

// ---------------------------------------------------------------------------------------------
// git

interface GitResult { ok: boolean; stdout: string; stderr: string }

function gitRaw(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
      // English messages so failures can be classified; no optional index.lock writes, so a
      // scoped run never races the developer's own git commands.
      env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new GitScopeError('git was not found on PATH. Install git, or scope the run with a patch file instead of a git range.'));
      } else resolve({ ok: !err, stdout, stderr });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await gitRaw(cwd, args);
  if (r.ok) return r.stdout;
  if (/not a git repository/i.test(r.stderr)) {
    throw new GitScopeError(`no git repository found at or above ${cwd}. Use a patch file instead if this tree is not a git checkout.`);
  }
  if (/dubious ownership/i.test(r.stderr)) {
    throw new GitScopeError(`git refuses to use the repository at ${cwd} because it is owned by another user; add it to safe.directory (git config --global --add safe.directory <path>).\n${r.stderr.trim()}`);
  }
  throw new GitScopeError(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr.trim()}`);
}

const line1 = (s: string) => s.replace(/\r?\n$/, '');

async function isShallow(top: string): Promise<boolean> {
  return line1(await git(top, ['rev-parse', '--is-shallow-repository'])) === 'true';
}

const SHALLOW_HINT = 'The repository is a shallow clone, so older history is missing; fetch full history (actions/checkout: fetch-depth: 0, or git fetch --unshallow).';

async function resolveCommit(top: string, ref: string): Promise<string> {
  // --end-of-options keeps a ref like "-x" from being read as an option.
  const r = await gitRaw(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  if (r.ok) return line1(r.stdout);
  if (ref === 'HEAD' && !(await gitRaw(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok) {
    throw new GitScopeError(`cannot resolve git ref 'HEAD': the repository has no commits yet. Use from=${EMPTY} to scope everything, or commit first.`);
  }
  let msg = `cannot resolve git ref '${ref}' to a commit. Use a branch, tag or commit, ${LOCAL} for uncommitted changes, or ${EMPTY} for the empty tree.`;
  if (await isShallow(top)) msg += ' ' + SHALLOW_HINT;
  else if (/^[\w./-]+$/.test(ref) && !ref.includes('/')) msg += ` If it is a remote branch, try origin/${ref}.`;
  throw new GitScopeError(msg);
}

export interface GitChangedLinesOptions {
  /** Any directory inside the repository; git runs here to find it. */
  cwd: string;
  /** Directory paths are reported relative to (the repository root or a subdirectory). */
  root: string;
  /**
   * Base of the range. Default `HEAD`. `-Empty-` is the empty tree. `A...B` diffs the merge base
   * of A and B against B (B defaulting to `to`, then HEAD); `A..B` is shorthand for from=A to=B.
   */
  from?: string;
  /** Tip of the range. Default `-Local-`: the working tree with staged, unstaged and untracked files. */
  to?: string;
}

export async function gitChangedLines(opts: GitChangedLinesOptions): Promise<ChangedLines> {
  let from = opts.from?.trim() || 'HEAD';
  let to = opts.to?.trim() || LOCAL;
  for (const d of [opts.cwd, opts.root]) {
    if (!existsSync(d)) throw new GitScopeError(`directory does not exist: ${d}`);
  }
  const top = line1(await git(opts.cwd, ['rev-parse', '--show-toplevel']));
  const rootTop = line1(await git(opts.root, ['rev-parse', '--show-toplevel']));
  if (!samePath(top, rootTop)) {
    throw new GitScopeError(`root ${opts.root} is not inside the repository at ${top}`);
  }
  const prefix = line1(await git(opts.root, ['rev-parse', '--show-prefix'])); // "sub/dir/" or ""

  // Range syntax in `from`. Refs cannot contain "..", so the split is unambiguous.
  let fromLabel = from;
  const range = /^(.*?)(\.\.\.?)(.*)$/.exec(from);
  if (range) {
    const [, a = '', dots, b = ''] = range;
    if (b && opts.to?.trim()) throw new GitScopeError(`from '${from}' names a tip, so 'to' must not be given as well`);
    if (b) to = b;
    if (dots === '...') {
      const tip = to === LOCAL ? 'HEAD' : to;
      const [ca, cb] = [await resolveCommit(top, a || 'HEAD'), await resolveCommit(top, tip)];
      const r = await gitRaw(top, ['merge-base', ca, cb]);
      if (!r.ok) {
        throw new GitScopeError(`'${a || 'HEAD'}' and '${tip}' have no merge base.${(await isShallow(top)) ? ' ' + SHALLOW_HINT : ''}`);
      }
      from = line1(r.stdout);
      fromLabel = `the merge base of ${a || 'HEAD'} and ${tip} (${from.slice(0, 12)})`;
    } else fromLabel = from = a || 'HEAD';
  }
  if (from === LOCAL) throw new GitScopeError(`${LOCAL} can only be the tip ('to') of a range`);

  // git hard-codes the empty tree, so it needs no object in the repository; its id depends on
  // the repository's hash algorithm.
  const emptyTree = async () =>
    line1(await git(top, ['rev-parse', '--show-object-format'])) === 'sha256'
      ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
      : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const fromId = from === EMPTY ? await emptyTree() : await resolveCommit(top, from);
  const toId = to === LOCAL ? null : to === EMPTY ? await emptyTree() : await resolveCommit(top, to);
  if (from === EMPTY) fromLabel = 'the empty tree';

  const diff = await git(top, [
    // Explicit settings beat user config that would change the text we parse: quoting is
    // decoded either way, prefixes are pinned against diff.noprefix/mnemonicPrefix, textconv
    // would renumber lines, and an external diff tool would replace the format entirely.
    '-c', 'core.quotePath=true', 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '--ignore-submodules', '--src-prefix=a/', '--dst-prefix=b/',
    // -U1, not -U0: one context line makes a deletion at end of file recognisable (it has no
    // trailing context), so it can be clamped without reading the file.
    '-U1',
    // Follow renames so a moved file with small edits yields only its edited lines on the new
    // path, instead of flooding the run with mutants in code nobody touched.
    '-M',
    ...(prefix ? [`--relative=${prefix}`] : []),
    fromId, ...(toId ? [toId] : []), '--',
  ]);
  const acc: Acc = new Map();
  parseInto(diff, acc, { stripPrefix: 1 }, true);

  let untracked = 0;
  if (to === LOCAL) {
    // Untracked files are invisible to git diff but are as much "what I have right now" as an
    // edit; every line counts as added. ls-files run in root lists root's subtree relative to it.
    const listed = (await git(opts.root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    for (const rel of listed) {
      let buf: Buffer;
      try { buf = await readFile(join(opts.root, rel)); } catch { continue; } // e.g. a symlink to a directory
      if (buf.subarray(0, 8000).includes(0)) continue; // binary, by git's own heuristic
      const n = countLines(buf);
      if (n > 0) acc.set(rel, [[1, n]]), untracked++;
    }
  }

  // --relative already made diff paths root-relative, so no further re-rooting.
  const files = finish(acc, undefined);
  const toLabel = to === LOCAL ? 'the working tree' : to === EMPTY ? 'the empty tree' : to;
  const extra = untracked ? `, ${untracked} untracked` : '';
  return { files, description: `changes from ${fromLabel} to ${toLabel} (${summary(files)}${extra})` };
}

function countLines(buf: Buffer): number {
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return buf.length > 0 && buf[buf.length - 1] !== 10 ? n + 1 : n;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = p;
    try { r = realpathSync.native(p); } catch { /* compare as given */ }
    r = r.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * Where `dir` sits in its repository, as a path prefix ("packages/app/", or "" at the root), for
 * paths that must be repository-relative; undefined outside a repository or without git.
 */
export async function repositoryPrefix(dir: string): Promise<string | undefined> {
  const r = await gitRaw(dir, ['rev-parse', '--show-prefix']).catch(() => undefined);
  return r?.ok ? line1(r.stdout) : undefined;
}
