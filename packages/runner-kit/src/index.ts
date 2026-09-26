/**
 * What the runner adapters share. Adapters that run their runner in a host process of their own
 * (node:test, Mocha) take the session, the host loop and the module hooks from here; every
 * adapter takes the small helpers.
 */
export { HostedSession, progressDir, type HostedRunner } from './session.js';
export { serveHost, type HostedExecutor, type HostSetup } from './serve.js';
export { InstrumentedModules } from './modules.js';
export { cleanUrl, firstMessage, realPath, sameHits, urlToNorm } from './util.js';
