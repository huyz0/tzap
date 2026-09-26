/**
 * The node:test runner session: spawns a host process that runs one package's node:test suites
 * and talks to it over IPC. Implements the engine's `RunnerSession` contract.
 *
 * - Warm (default): one host serves every run; test files re-evaluate per run, modules under
 *   test stay loaded. After many tries the host is replaced between runs, because node:test
 *   keeps every test it ever ran reachable (a few KB per try).
 * - `isolate: true`: every run gets a host that has never run anything, so a static mutant is
 *   active before any module evaluates. The next host is started as soon as a run ends.
 */
import { fork, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readProgress, type HostRequest, type HostResponse, type RunRequest, type RunResult, type RunnerFactory, type RunnerSession, type SessionOptions } from '@tzap/protocol';
import { progressDir } from './progress.js';

/** Tries a warm host runs before it is replaced (node:test retains ~3 KB per try). */
const RECYCLE_AFTER_TRIES = 50_000;

class Host {
  readonly child: ChildProcess;
  private stderr = '';
  private exited = false;
  ready: Promise<string>;
  private onReady: { resolve: (v: string) => void; reject: (e: Error) => void } | undefined;
  private pending: { id: number; resolve: (r: RunResult) => void; reject: (e: Error) => void } | undefined;
  private listing: ((files: string[]) => void) | undefined;
  used = false;

  constructor(options: SessionOptions) {
    const child = fork(path.join(import.meta.dirname, 'host.js'), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' },
      serialization: 'advanced',
    });
    this.child = child;
    this.ready = new Promise((resolve, reject) => (this.onReady = { resolve, reject }));
    this.ready.catch(() => {});
    child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000);
    });
    child.on('message', (m: HostResponse) => this.onMessage(m));
    child.on('exit', (code, signal) => {
      this.exited = true;
      const err = new Error(`the node:test host exited (code ${code}, signal ${signal})${this.stderr ? `:\n${this.stderr}` : ''}`);
      this.onReady?.reject(err);
      this.onReady = undefined;
      const p = this.pending;
      this.pending = undefined;
      p?.reject(err);
    });
    child.send({ type: 'init', options } satisfies HostRequest);
  }

  get alive(): boolean {
    return !this.exited;
  }

  private onMessage(m: HostResponse): void {
    switch (m.type) {
      case 'ready':
        this.onReady?.resolve(m.runnerVersion);
        this.onReady = undefined;
        break;
      case 'files':
        this.listing?.(m.files);
        this.listing = undefined;
        break;
      case 'result': {
        const p = this.pending;
        this.pending = undefined;
        p?.resolve(m.result);
        break;
      }
      case 'error':
        if (m.during === 'init' && this.onReady) {
          this.onReady.reject(new Error(m.message));
          this.onReady = undefined;
        } else if (m.during === 'run' && this.pending) {
          const p = this.pending;
          this.pending = undefined;
          p.reject(new Error(m.message));
        } else {
          this.stderr = (this.stderr + m.message).slice(-8000);
        }
        break;
    }
  }

  run(request: RunRequest): Promise<RunResult> {
    this.used = true;
    return new Promise((resolve, reject) => {
      this.pending = { id: request.id, resolve, reject };
      this.child.send({ type: 'run', request } satisfies HostRequest);
    });
  }

  /** Settles the pending run, if any, without waiting for the host. */
  abandon(result: RunResult): void {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve(result);
  }

  list(): Promise<string[]> {
    return new Promise((resolve) => {
      this.listing = resolve;
      this.child.send({ type: 'list' } satisfies HostRequest);
    });
  }

  kill(): void {
    if (!this.exited) this.child.kill('SIGKILL');
  }

  async close(): Promise<void> {
    if (this.exited) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.kill();
        resolve();
      }, 5000);
      this.child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        this.child.send({ type: 'close' } satisfies HostRequest);
      } catch {
        this.kill();
      }
    });
  }
}

export class NodeTestSession implements RunnerSession {
  readonly kind = 'node';
  private host: Host | undefined;
  private tries = 0;

  constructor(private readonly options: SessionOptions) {}

  async start(): Promise<{ runnerVersion: string }> {
    this.host = new Host(this.options);
    const runnerVersion = await this.host.ready;
    return { runnerVersion };
  }

  /** A host ready for the next run: a fresh one when isolating or when the warm one is spent. */
  private async hostForRun(request: RunRequest): Promise<Host> {
    let host = this.host;
    const tries = Object.values(request.plan ?? {}).reduce((a, l) => a + l.length, 0);
    const replace =
      !host || !host.alive || (this.options.isolate && host.used) || (!this.options.isolate && this.tries > 0 && this.tries + tries > RECYCLE_AFTER_TRIES);
    if (replace) {
      host?.kill();
      host = this.host = new Host(this.options);
      this.tries = 0;
    }
    await host!.ready;
    this.tries += tries;
    return host!;
  }

  listFiles(): Promise<string[]> {
    if (!this.host) return Promise.reject(new Error('the node:test host is not running'));
    return this.host.list();
  }

  async run(request: RunRequest): Promise<RunResult> {
    if (!this.host) throw new Error('the node:test host is not running');
    const host = await this.hostForRun(request);
    let timer: NodeJS.Timeout | undefined;
    if (request.budgetMs !== undefined) {
      // The wall-clock backstop fires on silence, not on total time: when the host has neither
      // started nor finished a try for budgetMs, something blocks it synchronously. Kill it; the
      // try that started and never finished is the culprit, and the engine starts a new session.
      const dir = progressDir(this.options.tmpDir || os.tmpdir(), host.child.pid);
      const started = Date.now();
      const window = request.budgetMs;
      timer = setInterval(() => {
        const entries = readProgress(dir).filter((e) => e.runId === request.id);
        const last = Math.max(started, ...entries.map((e) => e.at));
        if (Date.now() - last <= window) return;
        clearInterval(timer);
        const inFlight = entries.filter((e) => !e.done).map((e) => ({ test: e.test, mutant: e.mutant }));
        host.abandon({ id: request.id, tests: [], files: [], timedOut: true, inFlight, durationMs: Date.now() - started });
        host.kill();
        if (this.host === host) this.host = undefined;
      }, Math.min(500, window));
    }
    try {
      return await host.run(request);
    } finally {
      if (timer) clearInterval(timer);
      if (this.options.isolate && this.host === host) {
        // Start the next run's host now, while the engine digests this result.
        host.kill();
        this.host = new Host(this.options);
      }
    }
  }

  async close(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    // A host that never ran anything (the one started ahead for an isolated run) holds no state.
    if (host && !host.used) host.kill();
    else await host?.close();
  }
}

export const createNodeTestSession: RunnerFactory = (options) => new NodeTestSession(options);
