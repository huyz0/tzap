/**
 * What the runner adapters share. Every adapter runs its runner in a host process of its own and
 * takes the session and the host loop from here; node:test and Mocha, which load modules through
 * Node's own hooks, take those too.
 */
export { HostedSession, progressDir, type HostedRunner, type SessionInfo } from './session.js';
export { serveHost, type HostContext, type HostedExecutor, type HostReady, type HostSetup } from './serve.js';
export { InstrumentedModules } from './modules.js';
export { cleanUrl, firstMessage, realPath, urlToNorm } from './util.js';
