/**
 * The Vitest runner session: a host process that owns one Vitest instance for one package (see
 * @tzap/runner-kit's HostedSession). Vitest isolates test files itself when asked, so one host
 * serves isolated runs too, and its setup file can activate a different static mutant in each
 * test file.
 */
import path from 'node:path';
import type { RunnerFactory, SessionOptions } from '@tzap/protocol';
import { HostedSession, type HostedRunner } from '@tzap/runner-kit';

const VITEST: HostedRunner = {
  kind: 'vitest',
  label: 'the Vitest host',
  hostScript: path.join(import.meta.dirname, 'host.js'),
  progressName: 'vitest',
  isolatesItself: true,
  staticPerFile: true,
};

export class VitestSession extends HostedSession {
  constructor(options: SessionOptions) {
    super(VITEST, options);
  }
}

export const createVitestSession: RunnerFactory = (options) => new VitestSession(options);
