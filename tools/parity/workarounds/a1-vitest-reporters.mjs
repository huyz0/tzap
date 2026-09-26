// Harness-side workaround for class-A finding A1 (see reports/*.md, README.md): tzap's Vitest
// host passes `reporters: []` to createVitest(). Vitest 4.1 replaces an empty reporter list with
// its `default` (or, under an AI agent, `agent`) reporter; tzap never initialises reporters, so
// the first onTestRunEnd throws "Cannot read properties of undefined (reading 'logger'|'state')"
// and every tzap run on Vitest 4.1 fails with exit 3. Vitest 5 keeps the empty list.
//
// Active only inside tzap's Vitest host (which sets TZAP=1), and only when Vitest substituted
// its single default reporter; it replaces that with one inert inline reporter. Reporters do
// not influence verdicts. Remove once A1 is fixed in @tzap/runner-vitest.
export default function a1VitestReporters() {
  return {
    name: 'tzap-parity:a1-vitest-reporters',
    configureVitest({ vitest }) {
      const r = vitest.config.reporters;
      if (process.env.TZAP === '1' && r.length === 1 && Array.isArray(r[0]) && ['default', 'agent'].includes(r[0][0])) {
        vitest.config.reporters = [{}];
      }
    },
  };
}
