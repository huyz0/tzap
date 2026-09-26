export { analyse } from './engine/analyse.js';
export type { EngineEvent, EngineKind, EngineOptions, MutantCoverage } from './engine/options.js';
export { sourceFiles, relativeTo, toPosix } from './files.js';
export { loadCache, saveCache, fingerprint, type Cache, type CacheSettings } from './cache.js';
export { ImportGraph } from './graph.js';
