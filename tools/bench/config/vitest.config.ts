// Copied into the bench work directory next to the generated fixture.
//
// Workaround, not configuration: tzap's Vitest host passes `reporters: []` and never calls
// `vitest.init()`. Vitest 5 accepts that; Vitest 4.1 replaces an empty reporter list with its
// default (or, under an AI agent, the "agent") reporter, whose onInit never ran, and it crashes on
// `this.ctx.state` at the end of the first run. The bench has to use Vitest 4.1 because Stryker's
// Vitest runner 10.0.0 does not work on Vitest 5 (stryker-js#6210). Clearing the reporter list when
// tzap is the caller (tzap sets TZAP=1 in its host) restores what tzap asked for; Stryker's runs
// are untouched. Remove once packages/runner-vitest supports Vitest 4.1 itself.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'tzap-bench:vitest41-empty-reporters',
      configureVitest({ vitest }: { vitest: { config: { reporters: unknown[] } } }) {
        if (process.env.TZAP === '1') vitest.config.reporters.splice(0);
      },
    },
  ],
});
