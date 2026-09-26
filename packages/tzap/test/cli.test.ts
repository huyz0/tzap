/**
 * The command line as a user meets it: exit codes, what goes to stdout, and that the commands
 * agree with each other. The analysis itself is covered by e2e.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, VERSION } from '../src/cli.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const sample = path.join(repo, 'fixtures', 'sample-vitest');
const typed = path.join(repo, 'fixtures', 'typed-vitest');
const scratch = mkdtempSync(path.join(tmpdir(), 'tzap-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let out = '';
let err = '';
beforeEach(() => {
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => vi.restoreAllMocks());

/** Runs the CLI in `cwd`; returns its exit code (stdout and stderr are in `out` and `err`). */
const tzap = (args: string[], cwd = sample) => main(args, cwd);
const listed = async (args: string[], cwd = sample) => {
  out = '';
  expect(await tzap(['list-mutants', '--typecheck', 'off', ...args], cwd)).toBe(0);
  // Run inside this repository, the fixture is a member of its workspace: paths carry its prefix.
  return (JSON.parse(out) as Array<{ file: string; mutatorName: string; location: { start: { line: number } }; ignoredBy?: string }>).map((m) => ({
    ...m,
    file: m.file.replace(/^fixtures\/sample-vitest\//, ''),
  }));
};
/** A patch that touches `lines` of `file` in the sample fixture without changing them. */
function patchOf(file: string, lines: [number, number]): string {
  const text = readFileSync(path.join(sample, file), 'utf8').split('\n');
  const [a, b] = lines;
  const body = text.slice(a - 1, b);
  const p = path.join(scratch, `${path.basename(file)}-${a}-${b}.patch`);
  writeFileSync(p, `--- a/${file}\n+++ b/${file}\n@@ -${a},${body.length} +${a},${body.length} @@\n${body.map((l) => `-${l}`).join('\n')}\n${body.map((l) => `+${l}`).join('\n')}\n`);
  return p;
}

describe('the command line', () => {
  it('prints help and the version, from anywhere on the line', async () => {
    expect(await tzap([])).toBe(2);
    expect(out).toMatch(/^tzap .* — fast, diff-aware mutation testing/);
    expect(await tzap(['--help'])).toBe(0);
    for (const args of [['--version'], ['-v'], ['run', '--version'], ['list-mutants', '-v']]) {
      out = '';
      expect(await tzap(args), args.join(' ')).toBe(0);
      expect(out).toBe(`${VERSION}\n`);
    }
  });

  it('exits 2 with a message on a usage error', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['frobnicate'], /unknown command "frobnicate"/],
      [['run', '--no-such-option'], /Unknown option/],
      [['run', '--engine', 'fast'], /--engine: expected warm or reference/],
      [['run', '--mutators', 'Nope'], /--mutators: unknown Nope/],
      [['run', '--reporters', 'pdf'], /--reporters: unknown pdf/],
      [['run', '--threshold', '101'], /--threshold: expected a percentage/],
      [['run', '--threshold', ''], /--threshold: expected a percentage/],
      [['run', '--workers', '0'], /--workers: expected a whole number of at least 1/],
      [['run', '--workers', '1.5'], /--workers: expected a whole number/],
      [['run', '--typecheck', 'maybe'], /--typecheck: expected off, survivors or all/],
      [['run', '--verify-survivors', 'some'], /--verify-survivors: expected auto, all or off/],
      [['run', '--scope', 'hunk', '--patch', 'x.patch'], /--scope: expected line, function or file/],
      [['run', '--scope', 'function'], /--scope widens a diff scope/],
      [['list-mutants', '--mutators', 'Nope'], /--mutators: unknown Nope/],
    ];
    for (const [args, message] of cases) {
      err = '';
      expect(await tzap(args), args.join(' ')).toBe(2);
      expect(err, args.join(' ')).toMatch(message);
    }
  });

  it('lists every mutator, marking the opt-in ones', async () => {
    expect(await tzap(['mutators'])).toBe(0);
    const names = out.trim().split('\n');
    expect(names).toContain('EqualityOperator');
    expect(names).toContain('FunctionBody  (opt-in: --mutators FunctionBody, or --extreme)');
  });

  it('prints the discovered model, or writes it to a file', async () => {
    expect(await tzap(['model'])).toBe(0);
    const model = JSON.parse(out);
    expect(model.packages).toHaveLength(1);
    expect(model.packages[0].runner.kind).toBe('vitest');
    const file = path.join(scratch, 'model.json');
    out = '';
    expect(await tzap(['model', '-o', file])).toBe(0);
    expect(out).toBe('');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(model);
  });

  it('lists the inventory run would analyse: same mutators, reductions and scope', async () => {
    const all = await listed([]);
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((m) => m.file))).toEqual(new Set(['src/discount.ts', 'src/strings.ts']));
    const extreme = await listed(['--extreme']);
    expect(new Set(extreme.map((m) => m.mutatorName))).toEqual(new Set(['FunctionBody']));
    const onePerLine = (await listed(['--one-per-line'])).filter((m) => !m.ignoredBy);
    expect(new Set(onePerLine.map((m) => `${m.file}:${m.location.start.line}`)).size).toBe(onePerLine.length);
    // A diff scope, then the same diff widened to the function that holds it.
    const patch = patchOf('src/discount.ts', [5, 5]);
    const line = await listed(['--patch', patch]);
    expect(new Set(line.map((m) => m.location.start.line))).toEqual(new Set([5]));
    const fn = await listed(['--patch', patch, '--scope', 'function']);
    expect(Math.min(...fn.map((m) => m.location.start.line))).toBe(1);
    expect(fn.length).toBeGreaterThan(line.length);
    const file = await listed(['--patch', patch, '--scope', 'file']);
    expect(file.length).toBe(all.filter((m) => m.file === 'src/discount.ts').length);
  });

  it('names type rules once, as the rules name themselves', async () => {
    expect(await tzap(['list-mutants'], typed)).toBe(0);
    const rules = new Set((JSON.parse(out) as Array<{ ignoredBy?: string }>).map((m) => m.ignoredBy).filter((r) => r?.startsWith('type:')));
    expect(rules.size).toBeGreaterThan(0);
    for (const r of rules) expect(r).not.toMatch(/^type:type:/);
  }, 60_000);

  it('describes a dry run without running a test', async () => {
    expect(await tzap(['run', '--dry-run', '--patch', patchOf('src/strings.ts', [1, 1])])).toBe(0);
    expect(out).toMatch(/1 of 2 source files in scope/);
    expect(out).toMatch(/src\/strings\.ts lines 1/);
  });

  it('passes a threshold when a diff leaves nothing to score', async () => {
    // A patch touching only a blank line: no mutant is in scope.
    const text = readFileSync(path.join(sample, 'src/discount.ts'), 'utf8').split('\n');
    const blank = text.findIndex((l) => l.trim() === '') + 1;
    expect(blank).toBeGreaterThan(0);
    const code = await tzap(['run', '-q', '--typecheck', 'off', '-r', 'console', '--threshold', '90', '--patch', patchOf('src/discount.ts', [blank, blank])]);
    expect(code).toBe(0);
    expect(out).toMatch(/Threshold 90(\.0)?%: passed/);
  }, 60_000);
});
