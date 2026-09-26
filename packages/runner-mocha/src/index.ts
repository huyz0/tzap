/**
 * The Mocha runner session: a host process that runs one package's Mocha suites (see
 * @tzap/runner-kit's HostedSession). Warm, test files are loaded once, the first time a run names
 * them, and Mocha's suite tree is run again for every later run (`cleanReferencesAfterRun(false)`);
 * the modules under test stay loaded too. Mocha keeps nothing per run once the run's test copies
 * are dropped, so the host is never recycled.
 */
import path from 'node:path';
import type { RunnerFactory, SessionOptions } from '@tzap/protocol';
import { HostedSession, type HostedRunner } from '@tzap/runner-kit';

const MOCHA: HostedRunner = {
  kind: 'mocha',
  label: 'the Mocha host',
  hostScript: path.join(import.meta.dirname, 'host.js'),
  progressName: 'mocha',
};

export class MochaSession extends HostedSession {
  constructor(options: SessionOptions) {
    super(MOCHA, options);
  }
}

export const createMochaSession: RunnerFactory = (options) => new MochaSession(options);
