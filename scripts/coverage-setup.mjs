// Loaded into Vitest's workers by scripts/coverage.mjs only. Vitest stops its workers without
// letting Node write NODE_V8_COVERAGE, so each test file writes what it has run so far.
import { takeCoverage } from 'node:v8';
import { afterAll } from 'vitest';

afterAll(() => takeCoverage());
