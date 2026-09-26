import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config.ts';

// The test suite as `pnpm test` runs it, with each test file writing its V8 coverage when it ends.
export default mergeConfig(
  base,
  defineConfig({
    test: { setupFiles: ['scripts/coverage-setup.mjs'] },
  }),
);
