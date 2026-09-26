/**
 * The Mocha host: a child process that runs one package's Mocha suites for the engine, over the
 * IPC channel. Mocha runs in this process's main thread, as `mocha` without `--parallel` does, so
 * a mutant that blocks it forever is dealt with by killing the process: the session does that
 * when a run goes silent for its budget, and attributes the hang from the progress file this
 * process writes as each try starts and ends.
 */
import os from 'node:os';
import path from 'node:path';
import { progressWriter, type HostRequest, type HostResponse, type SessionOptions } from '@tzap/protocol';
import { Executor } from './executor.js';
import { progressDir } from './progress.js';

const send = (m: HostResponse) => process.send?.(m);

let executor: Executor | undefined;

function init(o: SessionOptions): void {
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  if (major < 22 || (major === 22 && minor < 15)) {
    throw new Error(`the Mocha adapter needs Node >= 22.15 (module.registerHooks); this is ${process.version}`);
  }
  const pkgRoot = path.resolve(o.root, o.pkg.root);
  process.chdir(pkgRoot);
  for (const [k, v] of Object.entries(o.pkg.env ?? {})) process.env[k] = v;
  process.env.TZAP = '1';
  // Written synchronously as each try starts and ends, so a try that blocks this thread for good
  // is on record for the session, which reads the file (see progressDir in index.ts).
  const progress = progressWriter(progressDir(o.tmpDir || os.tmpdir(), process.pid), String(process.pid));
  executor = new Executor({ session: o, pkgRoot, onProgress: progress });
  send({ type: 'ready', runnerVersion: executor.version });
}

process.on('message', (msg: HostRequest) => {
  void (async () => {
    try {
      if (msg.type === 'init') init(msg.options);
      else if (msg.type === 'run') send({ type: 'result', result: await executor!.run(msg.request) });
      else if (msg.type === 'list') send({ type: 'files', files: executor!.allFiles });
      else if (msg.type === 'close') {
        await executor?.close();
        process.exit(0);
      }
    } catch (e) {
      const err = e as Error;
      send({ type: 'error', message: `${err.message}\n${err.stack ?? ''}`, during: msg.type === 'init' ? 'init' : 'run' });
    }
  })();
});

// Between runs no Mocha runner is listening: a promise a timed-out try left behind must not take
// the host down. During a run Mocha's own handlers attribute these to the running test.
process.on('unhandledRejection', (e) => {
  // Mocha re-emits a rejection from user code on the process; under `mocha` Node then raises it
  // as an uncaught exception, which Mocha fails the running test with. This listener would stop
  // Node doing that, so it does it itself.
  if (executor?.running) {
    (process.emit as (ev: string, ...a: unknown[]) => boolean)('uncaughtException', e, 'unhandledRejection');
    return;
  }
  send({ type: 'error', message: `unhandled rejection in the Mocha host: ${String((e as Error)?.stack ?? e)}`, during: 'background' });
});
process.on('uncaughtException', (e) => {
  if (executor?.running) return; // Mocha's own listener fails the running test with it
  send({ type: 'error', message: `uncaught exception in the Mocha host: ${String((e as Error)?.stack ?? e)}`, during: 'background' });
});
process.on('disconnect', () => process.exit(0));
