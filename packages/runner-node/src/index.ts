/**
 * The node:test runner session: a host process that runs one package's node:test suites (see
 * @tzap/runner-kit's HostedSession). Warm, test files re-evaluate per run and the modules under
 * test stay loaded; after many tries the host is replaced between runs, because node:test keeps
 * every test it ever ran reachable (a few KB per try).
 */
import path from 'node:path';
import type { RunnerFactory, SessionOptions } from '@tzap/protocol';
import { HostedSession, type HostedRunner } from '@tzap/runner-kit';

/** Tries a warm host runs before it is replaced (node:test retains ~3 KB per try). */
const RECYCLE_AFTER_TRIES = 50_000;

const NODE_TEST: HostedRunner = {
  kind: 'node',
  label: 'the node:test host',
  hostScript: path.join(import.meta.dirname, 'host.js'),
  progressName: 'node-test',
  recycle: (tries, next) => tries + next > RECYCLE_AFTER_TRIES,
};

export class NodeTestSession extends HostedSession {
  constructor(options: SessionOptions) {
    super(NODE_TEST, options);
  }
}

export const createNodeTestSession: RunnerFactory = (options) => new NodeTestSession(options);
