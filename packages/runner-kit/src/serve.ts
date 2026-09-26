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
   * An error nothing handled: return true when the runner deals with it (a running test fails with
   * it). Otherwise, raised during a run in a host where tests run, it fails the run as one of its
   * `unhandledErrors`, and the engine decides the run's mutants in isolation, where it is
   * attributable; raised between runs, it is only reported.
   */
  handles?(kind: 'rejection' | 'exception', error: unknown): boolean;
  /** The tests run in other processes (Vitest's workers): an error here is the host's own, never a run's. */
  testsElsewhere?: boolean;
}

/** Serves the engine from this process, until it is told to close or the engine goes away. */
export function serveHost(setup: HostSetup): void {
  const send = (m: HostResponse) => process.send?.(m);
  let executor: HostedExecutor | undefined;
  /** Errors nothing handled during the current run; undefined between runs. */
  let runErrors: string[] | undefined;

  const run = async (request: RunRequest): Promise<RunResult> => {
    runErrors = [];
    // A test that calls process.exit would take the host, and the whole analysis, down. As under
    // Vitest, it fails instead.
    const exit = process.exit;
    process.exit = ((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? ''}) called during a test run`);
    }) as typeof process.exit;
    try {
      const result = await executor!.run(request);
      if (runErrors.length > 0) {
        const files = result.unhandledErrorFiles ?? (result.unhandledErrors ?? []).map(() => null);
        result.unhandledErrors = [...(result.unhandledErrors ?? []), ...runErrors];
        result.unhandledErrorFiles = [...files, ...runErrors.map(() => null)];
      }
      return result;
    } finally {
      process.exit = exit;
      runErrors = undefined;
    }
  };

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
        else if (msg.type === 'run') send({ type: 'result', result: await run(msg.request) });
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

  // No error may take the host down: a promise a timed-out try left behind, a timer a test set.
  const unhandled = (kind: 'rejection' | 'exception', e: unknown) => {
    if (setup.handles?.(kind, e)) return;
    const text = String((e as Error)?.stack ?? e);
    if (runErrors && !setup.testsElsewhere) runErrors.push(text.split('\n')[0]!.slice(0, 300));
    else send({ type: 'error', message: `${kind === 'rejection' ? 'unhandled rejection' : 'uncaught exception'} in ${setup.label}: ${text}`, during: 'background' });
  };
  process.on('unhandledRejection', (e) => unhandled('rejection', e));
  process.on('uncaughtException', (e) => unhandled('exception', e));
  process.on('disconnect', () => process.exit(0));
}
