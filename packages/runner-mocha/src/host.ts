/** The Mocha host process (see @tzap/runner-kit's serveHost). Mocha runs in its main thread, as `mocha` without `--parallel` does. */
import { serveHost } from '@tzap/runner-kit';
import { Executor } from './executor.js';

let executor: Executor | undefined;

serveHost({
  label: 'the Mocha host',
  progressName: 'mocha',
  needs: 'module.registerHooks',
  init(o, pkgRoot, progress) {
    executor = new Executor({ session: o, pkgRoot, onProgress: progress });
    return { executor, version: executor.version };
  },
  handles(kind, error) {
    if (!executor?.running) return false;
    // Mocha re-emits a rejection from user code on the process; under `mocha` Node then raises it
    // as an uncaught exception, which Mocha fails the running test with. The host's own listener
    // would stop Node doing that, so it does it itself. An uncaught exception Mocha's own
    // listener already fails the running test with.
    if (kind === 'rejection') (process.emit as (ev: string, ...a: unknown[]) => boolean)('uncaughtException', error, 'unhandledRejection');
    return true;
  },
});
