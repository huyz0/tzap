/** The node:test host process (see @tzap/runner-kit's serveHost). */
import os from 'node:os';
import path from 'node:path';
import { serveHost } from '@tzap/runner-kit';
import { Executor } from './executor.js';

serveHost({
  label: 'the node:test host',
  progressName: 'node-test',
  needs: "module.registerHooks, run() with isolation 'none'",
  init({ options: o, pkgRoot, progress }) {
    const timeout = Number(process.env.TZAP_NODE_TEST_TIMEOUT);
    const executor = new Executor({
      session: o,
      pkgRoot,
      dir: path.join(o.tmpDir || os.tmpdir(), `node-test-${process.pid}`),
      testTimeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      onProgress: progress,
    });
    return { executor, version: process.versions.node };
  },
});
