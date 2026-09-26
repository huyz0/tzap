/**
 * The Jest runner session: a host process that runs the package's Jest in band, once per run
 * (see @tzap/runner-kit's HostedSession). Jest gives every test file fresh modules on every run,
 * so one host serves isolated runs too.
 */
import path from 'node:path';
import type { RunnerFactory, SessionOptions } from '@tzap/protocol';
import { HostedSession, type HostedRunner } from '@tzap/runner-kit';

const JEST: HostedRunner = {
  kind: 'jest',
  label: 'the Jest host',
  hostScript: path.join(import.meta.dirname, 'host.js'),
  progressName: 'jest',
  isolatesItself: true,
  lists: false,
};

export class JestSession extends HostedSession {
  constructor(options: SessionOptions) {
    super(JEST, options);
  }
}

export const createJestSession: RunnerFactory = (options) => new JestSession(options);
