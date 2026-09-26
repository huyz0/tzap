import { defineConfig } from 'vitest/config';

// tzap's own fast unit suites, for running tzap on itself.
export default defineConfig({
  test: {
    include: ['packages/{model,instrument,report}/test/**/*.test.ts'],
  },
});
