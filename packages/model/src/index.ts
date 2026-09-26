/**
 * The tzap vocabulary: the project model (the seam every adapter produces and the engine
 * consumes), mutants, statuses and results. Depends on nothing, by rule: a data package that
 * pinned its consumers to a library would be a poor seam.
 */

export * from './project-model.js';
export * from './mutant.js';
export * from './result.js';
export * from './validate.js';
