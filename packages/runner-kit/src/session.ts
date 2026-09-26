/**
 * The engine's side of a runner that runs in a host process of its own (every runner does): the
 * host is forked, spoken to over IPC, killed when a run goes silent, and replaced when a run must
 * start from nothing. Implements the engine's `RunnerSession` contract.
 *
 * - Warm (default): one host serves every run.
 * - `isolate: true`: every run gets a host that has never run anything, so a static mutant is
 *   active before any module evaluates. The next host is started as soon as a run ends.
 */
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readProgress, type HostRequest, type HostResponse, type RunRequest, type RunResult, type RunnerSession, type SessionOptions } from '@tzap/protocol';

/** What differs between runners hosted this way. */
export interface HostedRunner {
  /** The runner kind the session reports. */
  kind: string;
  /** How errors name the host: "the Mocha host". */
  label: string;
  /** The host script to fork: it calls `serveHost`. */
  hostScript: string;
  /** Prefix of the host's progress directory, see `progressDir`. */
  progressName: string;
  /** Whether a warm host that has run `tries` tries must be replaced before running `next` more. */
  recycle?: (tries: number, next: number) => boolean;
  /**
   * The runner gives every test file fresh modules itself when the session asks for isolation, so
   * one host serves every isolated run; otherwise each isolated run gets a host of its own.
   */
  isolatesItself?: boolean;
  /** The host can activate a different static mutant in each test file (RunRequest.staticPlan). */
  staticPerFile?: boolean;
  /** The host can list the runner's test files. */
  lists?: boolean;
}

/** What a started session reports: RunnerSession.start's result. */
export type SessionInfo = Awaited<ReturnType<RunnerSession['start']>>;

/** Keep this much of a host's stderr, for the message when it dies. */
const STDERR_TAIL = 8000;
/** How long a host may take to close before it is killed. */
const CLOSE_TIMEOUT_MS = 5000;
/** How often the wall-clock backstop reads the progress files, at most. */
const BACKSTOP_POLL_MS = 500;
/**
 * Before a run's first try starts, the host loads and collects test files, which on a large
 * suite can be slow: the silence window is this many times longer until then.
 */
const STARTUP_WINDOWS = 3;

/** Where a host writes its progress file: by host process, so a replacement starts clean. */
export function progressDir(tmpDir: string | undefined, name: string, pid: number | undefined): string {
  return path.join(tmpDir || os.tmpdir(), `${name}-progress-${pid ?? 0}`);
}

class ProcessHost {
  readonly child: ChildProcess;
  private stderr = '';
  private exited = false;
  ready: Promise<SessionInfo>;
  private onReady: { resolve: (v: SessionInfo) => void; reject: (e: Error) => void } | undefined;
  private pending: { resolve: (r: RunResult) => void; reject: (e: Error) => void } | undefined;
  private listing: { resolve: (files: string[]) => void; reject: (e: Error) => void } | undefined;
  used = false;

  constructor(
    private readonly runner: HostedRunner,
    options: SessionOptions,
  ) {
    const child = fork(runner.hostScript, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' },
      serialization: 'advanced',
      // Its own process group, so a kill reaches the worker processes a runner starts too: one
      // stuck in a mutant's loop never notices its parent is gone.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    // A message sent as the host dies fails here, not as an exception that takes the engine down.
    child.on('error', (e) => {
      this.stderr = (this.stderr + String(e)).slice(-STDERR_TAIL);
    });
    this.ready = new Promise((resolve, reject) => (this.onReady = { resolve, reject }));
    this.ready.catch(() => {});
    child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-STDERR_TAIL);
    });
    child.on('message', (m: HostResponse) => this.onMessage(m));
    child.on('exit', (code, signal) => {
      this.exited = true;
      const err = new Error(`${runner.label} exited (code ${code}, signal ${signal})${this.stderr ? `:\n${this.stderr}` : ''}`);
      // Whatever was waiting on this host learns it is gone.
      for (const waiter of [this.onReady, this.pending, this.listing]) waiter?.reject(err);
      this.onReady = this.pending = this.listing = undefined;
    });
    child.send({ type: 'init', options } satisfies HostRequest);
  }

  get alive(): boolean {
    return !this.exited;
  }

  private onMessage(m: HostResponse): void {
    switch (m.type) {
      case 'ready':
        this.onReady?.resolve({ runnerVersion: m.runnerVersion, ...(m.isolatesFiles ? { isolatesFiles: true } : {}), ...(m.threads ? { threads: true } : {}) });
        this.onReady = undefined;
        break;
      case 'files':
        this.listing?.resolve(m.files);
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
          this.stderr = (this.stderr + m.message).slice(-STDERR_TAIL);
        }
        break;
    }
  }

  run(request: RunRequest): Promise<RunResult> {
    this.used = true;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
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
    if (this.exited) return Promise.reject(new Error(`${this.runner.label} is not running`));
    return new Promise((resolve, reject) => {
      this.listing = { resolve, reject };
      this.child.send({ type: 'list' } satisfies HostRequest);
    });
  }

  /** Kills the host and every process it started. */
  kill(): void {
    if (this.exited || this.child.pid === undefined) return;
    const pid = this.child.pid;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      else process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    this.child.kill('SIGKILL');
  }

  /** Asks the host to close (its runner's teardown runs); kills it if it has not within a timeout. */
  async close(): Promise<void> {
    if (this.exited) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.kill();
        resolve();
      }, CLOSE_TIMEOUT_MS);
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

export class HostedSession implements RunnerSession {
  readonly kind: string;
  private host: ProcessHost | undefined;
  /** Tries the current warm host has run. */
  private tries = 0;

  constructor(
    private readonly runner: HostedRunner,
    private readonly options: SessionOptions,
  ) {
    this.kind = runner.kind;
    if (runner.lists !== false) this.listFiles = () => (this.host ? this.host.list() : Promise.reject(new Error(`${runner.label} is not running`)));
  }

  async start(): Promise<SessionInfo> {
    this.host = new ProcessHost(this.runner, this.options);
    const info = await this.host.ready;
    return this.runner.staticPerFile ? { ...info, staticPerFile: true } : info;
  }

  /** Whether the next isolated run needs a host that has never run anything. */
  private get hostPerRun(): boolean {
    return this.options.isolate === true && !this.runner.isolatesItself;
  }

  /** A host ready for the next run: a fresh one when isolating, when the last one died, or when the warm one is spent. */
  private async hostForRun(request: RunRequest): Promise<ProcessHost> {
    let host = this.host!;
    const tries = Object.values(request.plan ?? {}).reduce((a, l) => a + l.length, 0);
    const spent = !this.hostPerRun && this.tries > 0 && this.runner.recycle?.(this.tries, tries) === true;
    if (!host.alive || (this.hostPerRun && host.used) || spent) {
      // A live host closes in the background, so its runner's teardown (and cleanup) runs.
      void host.close();
      host = this.host = new ProcessHost(this.runner, this.options);
      this.tries = 0;
    }
    await host.ready;
    this.tries += tries;
    return host;
  }

  /** Absent when the runner cannot list its test files. */
  readonly listFiles?: () => Promise<string[]>;

  async run(request: RunRequest): Promise<RunResult> {
    if (!this.host) throw new Error(`${this.runner.label} is not running`);
    const host = await this.hostForRun(request);
    let timer: NodeJS.Timeout | undefined;
    if (request.budgetMs !== undefined) {
      // The wall-clock backstop fires on silence, not on total time: when the host has neither
      // started nor finished a try for budgetMs, something blocks it synchronously. Kill it; the
      // try that started and never finished is the culprit, and the engine starts a new session.
      const dir = progressDir(this.options.tmpDir, this.runner.progressName, host.child.pid);
      const started = Date.now();
      const window = request.budgetMs;
      timer = setInterval(
        () => {
          // Some file systems keep modification times to the second: two of slack.
          const entries = readProgress(dir, started - 2000).filter((e) => e.runId === request.id);
          const last = entries.reduce((a, e) => Math.max(a, e.at), started);
          if (Date.now() - last <= (entries.length > 0 ? window : window * STARTUP_WINDOWS)) return;
          clearInterval(timer);
          const inFlight = entries.filter((e) => !e.done).map((e) => ({ test: e.test, mutant: e.mutant }));
          host.abandon({ id: request.id, tests: [], files: [], timedOut: true, inFlight, durationMs: Date.now() - started });
          host.kill();
          if (this.host === host) this.host = undefined;
        },
        Math.min(BACKSTOP_POLL_MS, window),
      );
    }
    try {
      return await host.run(request);
    } finally {
      if (timer) clearInterval(timer);
      if (this.hostPerRun && this.host === host) {
        // Start the next run's host now, while the engine digests this result. The used one
        // closes in the background, so its runner's teardown still runs.
        void host.close();
        this.host = new ProcessHost(this.runner, this.options);
      }
    }
  }

  async close(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    await host?.close();
  }
}
