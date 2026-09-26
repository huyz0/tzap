/**
 * The Jest runner session: spawns a host process that runs the package's Jest in band and talks to
 * it over IPC. Implements the engine's `RunnerSession` contract.
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { HostRequest, HostResponse, RunRequest, RunResult, RunnerFactory, RunnerSession, SessionOptions } from '@tzap/protocol';

export class JestSession implements RunnerSession {
  readonly kind = 'jest';
  private child: ChildProcess | undefined;
  private pending: { resolve: (r: RunResult) => void; reject: (e: Error) => void; id: number } | undefined;
  /** The try most recently started: in band, the only one that can be stuck. */
  private latest: { test: string; mutant: number; at: number } | undefined;
  private starting: { resolve: (v: { runnerVersion: string; isolatesFiles?: boolean }) => void; reject: (e: Error) => void } | undefined;
  private stderr = '';

  constructor(private readonly options: SessionOptions) {}

  start(): Promise<{ runnerVersion: string; isolatesFiles?: boolean }> {
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
      const err = new Error(`the Jest host exited (code ${code}, signal ${signal})${this.stderr ? `:\n${this.stderr}` : ''}`);
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
        // Jest gives every test file a fresh module registry on every run.
        this.starting?.resolve({ runnerVersion: m.runnerVersion, isolatesFiles: true });
        this.starting = undefined;
        break;
      case 'progress':
        if (this.pending && m.runId === this.pending.id) this.latest = { test: m.test, mutant: m.mutant, at: Date.now() };
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

  run(request: RunRequest): Promise<RunResult> {
    if (!this.child) return Promise.reject(new Error('the Jest host is not running'));
    this.latest = undefined;
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
        // The wall-clock backstop fires on silence: no try started for budgetMs means the host,
        // which runs tests in band, is blocked in the try it started last.
        const started = Date.now();
        timer = setInterval(() => {
          if (Date.now() - Math.max(started, this.latest?.at ?? 0) <= request.budgetMs!) return;
          const inFlight = this.latest ? [{ test: this.latest.test, mutant: this.latest.mutant }] : [];
          const p = this.pending;
          this.pending = undefined;
          this.child?.kill('SIGKILL');
          this.child = undefined;
          p?.resolve({ id: request.id, tests: [], files: [], timedOut: true, inFlight, durationMs: Date.now() - started });
        }, Math.min(500, request.budgetMs));
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

export const createJestSession: RunnerFactory = (options) => new JestSession(options);
