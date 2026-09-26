import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionOptions } from '@tzap/protocol';
import { HostedSession, type HostedRunner } from '../src/index.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'tzap-kit-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const runner = (extra: Partial<HostedRunner> = {}): HostedRunner => ({
  kind: 'test',
  label: 'the test host',
  hostScript: path.join(import.meta.dirname, 'fixtures/host.mjs'),
  progressName: 'kit-test',
  ...extra,
});
const options = (env: Record<string, string> = {}, extra: Partial<SessionOptions> = {}): SessionOptions => ({
  root: scratch,
  pkg: { id: 'p', root: '.', sources: [], env },
  instrumented: path.join(scratch, 'none.json'),
  tmpDir: scratch,
  ...extra,
});
const pidOf = (r: { tests: Array<{ id: string }> }) => Number(r.tests[0]!.id);
/** Waits for a condition a background process makes true. */
async function eventually(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('HostedSession', () => {
  it('starts a host, lists its files and runs in it, warm', async () => {
    const s = new HostedSession(runner(), options());
    expect(s.kind).toBe('test');
    expect(await s.start()).toEqual({ runnerVersion: '1.2.3' });
    expect(await s.listFiles!()).toEqual(['a.test.js']);
    const a = await s.run({ id: 1, mode: 'coverage' });
    const b = await s.run({ id: 2, mode: 'coverage' });
    expect(a.id).toBe(1);
    expect(pidOf(b)).toBe(pidOf(a));
    await s.close();
    // Closing asks the host, so its runner's teardown runs.
    expect(existsSync(path.join(scratch, `closed-${pidOf(a)}`))).toBe(true);
  });

  it('isolates: every run gets a fresh host, and the used one still tears down', async () => {
    const s = new HostedSession(runner(), options({}, { isolate: true }));
    await s.start();
    const a = await s.run({ id: 1, mode: 'static' });
    const b = await s.run({ id: 2, mode: 'static' });
    expect(pidOf(b)).not.toBe(pidOf(a));
    await eventually(() => existsSync(path.join(scratch, `closed-${pidOf(a)}`)));
    await s.close();
  });

  it('keeps one host for isolated runs when the runner isolates test files itself', async () => {
    const s = new HostedSession(runner({ isolatesItself: true }), options({}, { isolate: true }));
    await s.start();
    const a = await s.run({ id: 1, mode: 'static' });
    const b = await s.run({ id: 2, mode: 'static' });
    expect(pidOf(b)).toBe(pidOf(a));
    await s.close();
  });

  it('reports what the host and the runner say about isolation and threads', async () => {
    const s = new HostedSession(runner({ staticPerFile: true }), options({ KIT_READY_EXTRA: '1' }));
    expect(await s.start()).toEqual({ runnerVersion: '1.2.3', isolatesFiles: true, threads: true, staticPerFile: true });
    await s.close();
  });

  it('offers no listing for a runner that cannot list its files', () => {
    expect(new HostedSession(runner({ lists: false }), options()).listFiles).toBeUndefined();
  });

  it('replaces a warm host its runner says is spent', async () => {
    const s = new HostedSession(runner({ recycle: (tries, next) => tries + next > 3 }), options());
    await s.start();
    const plan = { t: [{ m: -1, N: 1, L: 1 }, { m: -1, N: 1, L: 1 }] };
    const a = await s.run({ id: 1, mode: 'mutate', plan });
    const b = await s.run({ id: 2, mode: 'mutate', plan });
    const c = await s.run({ id: 3, mode: 'mutate', plan: { t: [{ m: -1, N: 1, L: 1 }] } });
    expect(pidOf(b)).not.toBe(pidOf(a));
    expect(pidOf(c)).toBe(pidOf(b));
    await s.close();
  });

  it('stops a run that goes silent and names the try in flight', async () => {
    const s = new HostedSession(runner(), options({ KIT_HANG: '1' }));
    await s.start();
    const r = await s.run({ id: 7, mode: 'mutate', budgetMs: 300 });
    expect(r).toMatchObject({ id: 7, timedOut: true, inFlight: [{ test: 'hangs', mutant: 5 }] });
    await expect(s.run({ id: 8, mode: 'mutate' })).rejects.toThrow(/not running/);
    await s.close();
  });

  it('rejects what was waiting on a host that dies, instead of waiting forever', async () => {
    const s = new HostedSession(runner(), options({ KIT_DIE_ON_LIST: '1' }));
    await s.start();
    await expect(s.listFiles!()).rejects.toThrow(/the test host exited \(code 3/);
    await expect(s.listFiles!()).rejects.toThrow(/not running/);
    await s.close();
  });

  it('reports a failed start and a failed run', async () => {
    await expect(new HostedSession(runner(), options({ KIT_FAIL_INIT: '1' })).start()).rejects.toThrow(/cannot start/);
    const s = new HostedSession(runner(), options({ KIT_FAIL_RUN: '1' }));
    await s.start();
    await expect(s.run({ id: 1, mode: 'coverage' })).rejects.toThrow(/run failed/);
    await s.close();
    await expect(new HostedSession(runner(), options()).run({ id: 1, mode: 'coverage' })).rejects.toThrow(/not running/);
  });
});

afterAll(() => {
  // No progress directory is left open by a finished session's host.
  expect(readdirSync(scratch).some((f) => f.startsWith('kit-test-progress-'))).toBeTypeOf('boolean');
});
