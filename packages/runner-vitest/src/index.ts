/**
 * The Vitest runner session: spawns a host process that owns one Vitest instance and talks to
 * it over IPC. Implements the engine's `RunnerSession` contract.
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { readProgress, type HostRequest, type HostResponse, type RunRequest, type RunResult, type RunnerFactory, type RunnerSession, type SessionOptions } from '@tzap/protocol';

export class VitestSession implements RunnerSession {
  readonly kind = 'vitest';
  private child: ChildProcess | undefined;
  private pending: { resolve: (r: RunResult) => void; reject: (e: Error) => void; id: number } | undefined;
  private readonly inFlight = new Map<string, number>();
  private starting: { resolve: (v: { runnerVersion: string; staticPerFile?: boolean; isolatesFiles?: boolean; threads?: boolean }) => void; reject: (e: Error) => void } | undefined;
  private stderr = '';
  private listing: ((files: string[]) => void) | undefined;

  constructor(private readonly options: SessionOptions) {}

  start(): Promise<{ runnerVersion: string; staticPerFile?: boolean; isolatesFiles?: boolean; threads?: boolean }> {
    const hostPath = path.join(import.meta.dirname, 'host.js');
    const child = fork(hostPath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' },
      serialization: 'advanced',
    });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000);
    });
    child.on('message', (m: HostResponse) => this.onMessage(m));
    child.on('exit', (code, signal) => {
      const err = new Error(`the Vitest host exited (code ${code}, signal ${signal})${this.stderr ? `:\n${this.stderr}` : ''}`);
      this.starting?.reject(err);
      this.starting = undefined;
      if (this.pending) {
        const p = this.pending;
        this.pending = undefined;
        p.reject(err);
      }
      this.child = undefined;
    });
    return new Promise((resolve, reject) => {
      this.starting = { resolve, reject };
      this.send({ type: 'init', options: this.options });
    });
  }

  private send(m: HostRequest): void {
    this.child?.send(m);
  }

  private onMessage(m: HostResponse): void {
    switch (m.type) {
      case 'ready':
        // The setup file knows which test file it runs for, so an isolated run can activate a
        // different static mutant in each file.
        this.starting?.resolve({ runnerVersion: m.runnerVersion, staticPerFile: true, isolatesFiles: m.isolatesFiles === true, threads: m.threads === true });
        this.starting = undefined;
        break;
      case 'files':
        this.listing?.(m.files);
        this.listing = undefined;
        break;
      case 'progress':
        if (this.pending && m.runId === this.pending.id) this.inFlight.set(m.test, m.mutant);
        break;
      case 'result': {
        const p = this.pending;
        this.pending = undefined;
        p?.resolve(m.result);
        break;
      }
      case 'error':
        if (m.during === 'init' && this.starting) {
          this.starting.reject(new Error(m.message));
          this.starting = undefined;
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

  listFiles(): Promise<string[]> {
    if (!this.child) return Promise.reject(new Error('the Vitest host is not running'));
    return new Promise((resolve) => {
      this.listing = resolve;
      this.send({ type: 'list' });
    });
  }

  run(request: RunRequest): Promise<RunResult> {
    if (!this.child) return Promise.reject(new Error('the Vitest host is not running'));
    this.inFlight.clear();
    return new Promise<RunResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      this.pending = {
        id: request.id,
        resolve: (r) => {
          if (timer) clearInterval(timer);
          resolve(r);
        },
        reject: (e) => {
          if (timer) clearInterval(timer);
          reject(e);
        },
      };
      if (request.budgetMs !== undefined) {
        // The wall-clock backstop fires on silence, not on total time: when no worker has
        // started or finished a try for budgetMs, something blocks one synchronously. Kill the
        // host; the tries that started and never finished are the culprits.
        const dir = path.join(this.options.tmpDir, `progress-${this.child?.pid ?? 0}`);
        const started = Date.now();
        const window = request.budgetMs;
        timer = setInterval(() => {
          const entries = readProgress(dir).filter((e) => e.runId === request.id);
          const last = Math.max(started, ...entries.map((e) => e.at));
          if (Date.now() - last <= window) return;
          const inFlight = entries.filter((e) => !e.done).map((e) => ({ test: e.test, mutant: e.mutant }));
          const p = this.pending;
          this.pending = undefined;
          this.child?.kill('SIGKILL');
          this.child = undefined;
          p?.resolve({ id: request.id, tests: [], files: [], timedOut: true, inFlight, durationMs: Date.now() - started });
        }, Math.min(500, window));
      }
      this.send({ type: 'run', request });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      this.send({ type: 'close' });
    });
  }
}

export const createVitestSession: RunnerFactory = (options) => new VitestSession(options);
