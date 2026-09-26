import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitScopeError, gitChangedLines, repositoryPrefix } from '../src/index.js';

const temps: string[] = [];
afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true, maxRetries: 5 }); });

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'tzap-git-'));
  temps.push(d);
  return d;
}

function repo() {
  const dir = tmp();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  const commit = (msg = 'c') => (git('add', '-A'), git('commit', '-q', '-m', msg), git('rev-parse', 'HEAD'));
  const edit = (rel: string, n: number, change: (ls: string[]) => void) => {
    const ls = lines(n).trimEnd().split('\n');
    change(ls);
    write(rel, ls.join('\n') + (ls.length ? '\n' : ''));
  };
  const changed = async (o: { from?: string; to?: string; root?: string } = {}) =>
    Object.fromEntries((await gitChangedLines({ cwd: dir, root: o.root ?? dir, from: o.from, to: o.to })).files);
  return { dir, git, write, commit, edit, changed };
}

// Concurrent: each test owns its repository, and git spawns dominate the runtime on Windows.
describe.concurrent('gitChangedLines', () => {
  it('modified lines in the working tree and between commits', async () => {
    const r = repo();
    r.write('x.ts', lines(10)); const c1 = r.commit();
    r.edit('x.ts', 10, (ls) => { ls[2] = 'X3'; ls[6] = 'X7'; });
    expect(await r.changed()).toEqual({ 'x.ts': [[3, 3], [7, 7]] });
    const c2 = r.commit();
    expect(await r.changed({ from: c1, to: c2 })).toEqual({ 'x.ts': [[3, 3], [7, 7]] });
    expect(await r.changed({ from: `${c1}..${c2}` })).toEqual({ 'x.ts': [[3, 3], [7, 7]] });
    expect(await r.changed()).toEqual({});
    const res = await gitChangedLines({ cwd: r.dir, root: r.dir, from: 'HEAD~1', to: 'HEAD' });
    expect(res.description).toBe('changes from HEAD~1 to HEAD (1 file, 2 lines)');
  });

  it('an added file is changed in full', async () => {
    const r = repo();
    r.write('a.ts', lines(2)); r.commit();
    r.write('b.ts', lines(4)); r.commit();
    expect(await r.changed({ from: 'HEAD~1', to: 'HEAD' })).toEqual({ 'b.ts': [[1, 4]] });
  });

  it('untracked files count with -Local-, ignored and binary ones do not', async () => {
    const r = repo();
    r.write('.gitignore', 'ignored.ts\n'); r.write('a.ts', lines(2)); r.commit();
    r.write('new.ts', 'a\nb\nc'); r.write('ignored.ts', lines(3)); r.write('bin.dat', 'a\0b'); r.write('empty.ts', '');
    const res = await gitChangedLines({ cwd: r.dir, root: r.dir });
    expect(Object.fromEntries(res.files)).toEqual({ 'new.ts': [[1, 3]] });
    expect(res.description).toBe('changes from HEAD to the working tree (1 file, 3 lines, 1 untracked)');
    // An explicit commit tip leaves untracked files out.
    expect(await r.changed({ to: 'HEAD' })).toEqual({});
  });

  it('staged and unstaged changes together', async () => {
    const r = repo();
    r.write('x.ts', lines(10)); r.commit();
    r.edit('x.ts', 10, (ls) => { ls[1] = 'S2'; });
    r.git('add', 'x.ts');
    r.edit('x.ts', 10, (ls) => { ls[1] = 'S2'; ls[4] = 'U5'; });
    expect(await r.changed()).toEqual({ 'x.ts': [[2, 2], [5, 5]] });
  });

  it('deleted lines select the line that follows', async () => {
    const r = repo();
    r.write('x.ts', lines(10)); r.commit();
    r.edit('x.ts', 10, (ls) => ls.splice(3, 2)); // remove l4, l5; l6 is now line 4
    expect(await r.changed()).toEqual({ 'x.ts': [[4, 4]] });
    r.edit('x.ts', 10, (ls) => ls.splice(0, 1));
    expect(await r.changed()).toEqual({ 'x.ts': [[1, 1]] });
  });

  it('a deletion at end of file selects the new last line', async () => {
    const r = repo();
    r.write('x.ts', lines(10)); r.commit();
    r.edit('x.ts', 10, (ls) => ls.splice(8, 2));
    expect(await r.changed()).toEqual({ 'x.ts': [[8, 8]] });
    r.write('x.ts', ''); // emptied: nothing left to select
    expect(await r.changed()).toEqual({});
  });

  it('a deleted file has no entry', async () => {
    const r = repo();
    r.write('x.ts', lines(5)); r.write('y.ts', lines(5)); r.commit();
    r.git('rm', '-q', 'x.ts');
    r.edit('y.ts', 5, (ls) => { ls[0] = 'Y'; });
    expect(await r.changed()).toEqual({ 'y.ts': [[1, 1]] });
  });

  it('a rename with an edit yields only the edited line on the new path', async () => {
    const r = repo();
    r.write('src/old.ts', lines(20)); r.commit();
    r.git('mv', 'src/old.ts', 'src/new name.ts');
    r.edit('src/new name.ts', 20, (ls) => { ls[9] = 'edited'; });
    expect(await r.changed()).toEqual({ 'src/new name.ts': [[10, 10]] });
    r.commit();
    expect(await r.changed({ from: 'HEAD~1', to: 'HEAD' })).toEqual({ 'src/new name.ts': [[10, 10]] });
  });

  it('paths with spaces and non-ASCII characters', async () => {
    const r = repo();
    r.write('dir with space/a b.ts', lines(3)); r.write('café.ts', lines(3)); r.commit();
    r.edit('dir with space/a b.ts', 3, (ls) => { ls[1] = 'x'; });
    r.edit('café.ts', 3, (ls) => { ls[2] = 'x'; });
    r.write('naïve new.ts', 'q\n');
    expect(await r.changed()).toEqual({ 'dir with space/a b.ts': [[2, 2]], 'café.ts': [[3, 3]], 'naïve new.ts': [[1, 1]] });
  });

  it('-Empty- selects every line', async () => {
    const r = repo();
    r.write('a.ts', lines(3)); r.write('d/b.ts', lines(2)); r.commit();
    const res = await gitChangedLines({ cwd: r.dir, root: r.dir, from: '-Empty-', to: 'HEAD' });
    expect(Object.fromEntries(res.files)).toEqual({ 'a.ts': [[1, 3]], 'd/b.ts': [[1, 2]] });
    expect(res.description).toBe('changes from the empty tree to HEAD (2 files, 5 lines)');
    r.write('c.ts', 'x\n');
    expect(await r.changed({ from: '-Empty-' })).toEqual({ 'a.ts': [[1, 3]], 'c.ts': [[1, 1]], 'd/b.ts': [[1, 2]] });
  });

  it('a merge commit as the tip', async () => {
    const r = repo();
    r.write('x.ts', lines(10)); r.commit();
    r.git('checkout', '-q', '-b', 'feature');
    r.edit('x.ts', 10, (ls) => { ls[1] = 'F'; }); r.commit();
    r.git('checkout', '-q', 'main');
    r.write('y.ts', lines(2)); const mainTip = r.commit();
    r.git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
    expect(await r.changed({ from: mainTip, to: 'HEAD' })).toEqual({ 'x.ts': [[2, 2]] });
    // A...B: the merge base against B, so main's own change is not attributed to the branch.
    expect(await r.changed({ from: `${mainTip}...feature` })).toEqual({ 'x.ts': [[2, 2]] });
  });

  it('detached HEAD', async () => {
    const r = repo();
    r.write('x.ts', lines(5)); r.commit();
    r.edit('x.ts', 5, (ls) => { ls[3] = 'D'; }); r.commit();
    r.git('checkout', '-q', '--detach', 'HEAD');
    expect(await r.changed({ from: 'HEAD~1', to: 'HEAD' })).toEqual({ 'x.ts': [[4, 4]] });
    r.edit('x.ts', 5, (ls) => { ls[3] = 'D'; ls[0] = 'W'; });
    expect(await r.changed()).toEqual({ 'x.ts': [[1, 1]] });
  });

  it('CRLF content', async () => {
    const r = repo();
    r.write('x.ts', 'a\r\nb\r\nc\r\nd\r\n'); r.commit();
    r.write('x.ts', 'a\r\nB\r\nc\r\nd\r\ne');
    expect(await r.changed()).toEqual({ 'x.ts': [[2, 2], [5, 5]] });
  });

  it('content lines starting with +++ and --- inside a hunk', async () => {
    const r = repo();
    r.write('x.ts', ['a', '-- old;', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n'); r.commit();
    r.write('x.ts', ['a', '++ new;', 'b', 'c', 'd', 'e', 'f', 'g', 'H'].join('\n') + '\n');
    expect(await r.changed()).toEqual({ 'x.ts': [[2, 2], [9, 9]] });
  });

  it('root as a subdirectory reports paths relative to it and drops the rest', async () => {
    const r = repo();
    r.write('packages/a/src/x.ts', lines(3)); r.write('packages/b/y.ts', lines(3)); r.write('top.ts', lines(3)); r.commit();
    for (const f of ['packages/a/src/x.ts', 'packages/b/y.ts', 'top.ts']) r.edit(f, 3, (ls) => { ls[0] = 'z'; });
    r.write('packages/a/new.ts', 'n\n'); r.write('packages/b/new.ts', 'n\n');
    const root = path.join(r.dir, 'packages', 'a');
    expect(await r.changed({ root })).toEqual({ 'new.ts': [[1, 1]], 'src/x.ts': [[1, 1]] });
    // cwd elsewhere in the repository makes no difference.
    const res = await gitChangedLines({ cwd: path.join(r.dir, 'packages', 'b'), root });
    expect(Object.fromEntries(res.files)).toEqual({ 'new.ts': [[1, 1]], 'src/x.ts': [[1, 1]] });
  });
});

describe('gitChangedLines errors', () => {
  const fails = async (p: Promise<unknown>, ...patterns: RegExp[]) => {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(GitScopeError);
    for (const re of patterns) expect((e as Error).message).toMatch(re);
  };

  it('an unknown ref names the alternatives', async () => {
    const r = repo();
    r.write('x.ts', 'x\n'); r.commit();
    await fails(r.changed({ from: 'no-such-ref' }), /cannot resolve git ref 'no-such-ref'/, /-Local-/, /-Empty-/);
    await fails(r.changed({ to: 'nope2' }), /nope2/);
  });

  it('a repository with no commits suggests -Empty-', async () => {
    const r = repo();
    r.write('x.ts', 'x\n');
    await fails(r.changed(), /no commits yet/, /-Empty-/);
    expect(await r.changed({ from: '-Empty-' })).toEqual({ 'x.ts': [[1, 1]] });
  });

  it('outside a repository suggests a patch file', async () => {
    const dir = tmp();
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir); // in case the temp dir sits inside a checkout
    try {
      await fails(gitChangedLines({ cwd: dir, root: dir }), /no git repository/, /patch file/);
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = saved;
    }
  });

  it('a shallow clone missing the base suggests fetch-depth: 0', async () => {
    const r = repo();
    r.write('x.ts', lines(3)); r.commit(); r.edit('x.ts', 3, (ls) => { ls[0] = 'y'; }); r.commit();
    const clone = tmp();
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r.dir.replace(/\\/g, '/')}`, clone], { stdio: 'ignore' });
    await fails(gitChangedLines({ cwd: clone, root: clone, from: 'HEAD~1', to: 'HEAD' }), /shallow/, /fetch-depth: 0/);
  });

  it('git missing from PATH', async () => {
    const r = repo();
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      await fails(gitChangedLines({ cwd: r.dir, root: r.dir }), /git was not found on PATH/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('a root outside the repository', async () => {
    const r = repo();
    r.write('x.ts', 'x\n'); r.commit();
    const other = repo();
    await fails(gitChangedLines({ cwd: r.dir, root: other.dir }), /not inside the repository/);
  });
});

describe('repositoryPrefix', () => {
  it("is a directory's path within its repository, empty at the top, and undefined outside one", async () => {
    const repo = path.resolve(import.meta.dirname, '../../..');
    expect(await repositoryPrefix(repo)).toBe('');
    expect(await repositoryPrefix(path.join(repo, 'packages/git'))).toBe('packages/git/');
    const outside = mkdtempSync(path.join(tmpdir(), 'tzap-no-repo-'));
    try {
      expect(await repositoryPrefix(outside)).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
