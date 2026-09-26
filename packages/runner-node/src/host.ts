/**
 * The node:test host: a child process that runs one package's node:test suites for the engine,
 * over the IPC channel. The tests run in this process's main thread (with `isolation: 'none'`),
 * so a mutant that blocks it forever is dealt with by killing the process: the session does
 * that when a run goes silent for its budget, and attributes the hang from the progress file
 * this process writes as each try starts and ends.
 */
import path from 'node:path';
import os from 'node:os';
import { progressWriter, type HostRequest, type HostResponse, type SessionOptions } from '@tzap/protocol';
import { Executor } from './executor.js';
import { progressDir } from './progress.js';

const send = (m: HostResponse) => process.send?.(m);

let executor: Executor | undefined;

function init(o: SessionOptions): void {
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  if (major < 22 || (major === 22 && minor < 15)) {
    throw new Error(`the node:test adapter needs Node >= 22.15 (module.registerHooks, run() with isolation 'none'); this is ${process.version}`);
  }
  const pkgRoot = path.resolve(o.root, o.pkg.root);
  process.chdir(pkgRoot);
  for (const [k, v] of Object.entries(o.pkg.env ?? {})) process.env[k] = v;
  process.env.TZAP = '1';
  const timeout = Number(process.env.TZAP_NODE_TEST_TIMEOUT);
  // Written synchronously as each try starts and ends, so a try that blocks this thread for good
  // is on record for the session, which reads the file (see progressDir in index.ts).
  const progress = progressWriter(progressDir(o.tmpDir || os.tmpdir(), process.pid), String(process.pid));
  executor = new Executor({
    session: o,
    pkgRoot,
    dir: path.join(o.tmpDir || os.tmpdir(), `node-test-${process.pid}`),
    testTimeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    onProgress: progress,
  });
  send({ type: 'ready', runnerVersion: process.versions.node });
}

process.on('message', (msg: HostRequest) => {
  void (async () => {
    try {
      if (msg.type === 'init') init(msg.options);
      else if (msg.type === 'run') send({ type: 'result', result: await executor!.run(msg.request) });
      else if (msg.type === 'list') send({ type: 'files', files: executor!.allFiles });
      else if (msg.type === 'close') process.exit(0);
    } catch (e) {
      const err = e as Error;
      send({ type: 'error', message: `${err.message}\n${err.stack ?? ''}`, during: msg.type === 'init' ? 'init' : 'run' });
    }
  })();
});

// Between runs no node:test root is listening: a promise a timed-out try left behind must not
// take the host down. During a run node:test's own handlers attribute these to tests.
process.on('unhandledRejection', (e) => {
  send({ type: 'error', message: `unhandled rejection in the node:test host: ${String((e as Error)?.stack ?? e)}`, during: 'background' });
});
process.on('uncaughtException', (e) => {
  send({ type: 'error', message: `uncaught exception in the node:test host: ${String((e as Error)?.stack ?? e)}`, during: 'background' });
});
process.on('disconnect', () => process.exit(0));
