/**
 * The host's side: a child process that runs one package's tests for the engine over the IPC
 * channel. The tests run in this process's main thread, so a mutant that blocks it forever is
 * dealt with by killing the process: the session does that when a run goes silent for its
 * budget, and attributes the hang from the progress file this process writes as each try starts
 * and ends.
 */
import path from 'node:path';
import { progressWriter, type HostRequest, type HostResponse, type RunRequest, type RunResult, type SessionOptions } from '@tzap/protocol';
import { progressDir } from './session.js';

/** What a hosted runner's executor offers the host. */
export interface HostedExecutor {
  run(request: RunRequest): Promise<RunResult>;
  /** Every test file the runner would run. Absent: the runner cannot list them. */
  listFiles?(): string[] | Promise<string[]>;
  /** The runner's own teardown, when the host is asked to close. */
  close?(): Promise<void>;
}

/** What `init` hands the runner. */
export interface HostContext {
  options: SessionOptions;
  /** The package directory, now the working directory. */
  pkgRoot: string;
  /** Records the start and end of each try, synchronously, in this process's progress file. */
  progress: ReturnType<typeof progressWriter>;
  /** The directory the session reads progress files from: workers of the runner may write there too. */
  progressDir: string;
}

/** A started runner, and what the session learns about it. */
export interface HostReady {
  executor: HostedExecutor;
  version: string;
  /** Every test file gets fresh module state on every run. */
  isolatesFiles?: boolean;
  /** The runner took worker threads (SessionOptions.preferThreads). */
  threads?: boolean;
}

export interface HostSetup {
  /** How errors name the host: "the Mocha host". */
  label: string;
  /** As the session's `HostedRunner.progressName`. */
  progressName: string;
  /** Why the runner needs Node 22.15, named in the error on an older Node; absent when it does not. */
  needs?: string;
  /** Starts the runner, in the package directory with the package's environment set. */
  init(context: HostContext): HostReady | Promise<HostReady>;
  /**
   * An error nothing handled, raised while no run is active or by the runner itself: return true
   * when the runner deals with it (a running test fails with it), false to report it.
   */
  handles?(kind: 'rejection' | 'exception', error: unknown): boolean;
}

/** Serves the engine from this process, until it is told to close or the engine goes away. */
export function serveHost(setup: HostSetup): void {
  const send = (m: HostResponse) => process.send?.(m);
  let executor: HostedExecutor | undefined;

  const init = async (options: SessionOptions) => {
    const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
    if (setup.needs && (major < 22 || (major === 22 && minor < 15))) throw new Error(`${setup.label} needs Node >= 22.15 (${setup.needs}); this is ${process.version}`);
    const pkgRoot = path.resolve(options.root, options.pkg.root);
    process.chdir(pkgRoot);
    for (const [k, v] of Object.entries(options.pkg.env ?? {})) process.env[k] = v;
    process.env.TZAP = '1';
    // Written synchronously as each try starts and ends, so a try that blocks this thread for
    // good is on record for the session, which reads the file.
    const dir = progressDir(options.tmpDir, setup.progressName, process.pid);
    const progress = progressWriter(dir, String(process.pid));
    const ready = await setup.init({ options, pkgRoot, progress, progressDir: dir });
    executor = ready.executor;
    send({ type: 'ready', runnerVersion: ready.version, ...(ready.isolatesFiles ? { isolatesFiles: true } : {}), ...(ready.threads ? { threads: true } : {}) });
  };

  process.on('message', (msg: HostRequest) => {
    void (async () => {
      try {
        if (msg.type === 'init') await init(msg.options);
        else if (msg.type === 'run') send({ type: 'result', result: await executor!.run(msg.request) });
        else if (msg.type === 'list') send({ type: 'files', files: await (executor!.listFiles?.() ?? []) });
        else if (msg.type === 'close') {
          await executor?.close?.();
          process.exit(0);
        }
      } catch (e) {
        const err = e as Error;
        send({ type: 'error', message: `${err.message}\n${err.stack ?? ''}`, during: msg.type === 'init' ? 'init' : 'run' });
      }
    })();
  });

  // Between runs no test runner is listening: a promise a timed-out try left behind must not take
  // the host down. During a run the runner's own handlers attribute these to tests.
  process.on('unhandledRejection', (e) => {
    if (setup.handles?.('rejection', e)) return;
    send({ type: 'error', message: `unhandled rejection in ${setup.label}: ${String((e as Error)?.stack ?? e)}`, during: 'background' });
  });
  process.on('uncaughtException', (e) => {
    if (setup.handles?.('exception', e)) return;
    send({ type: 'error', message: `uncaught exception in ${setup.label}: ${String((e as Error)?.stack ?? e)}`, during: 'background' });
  });
  process.on('disconnect', () => process.exit(0));
}
