// Spike B.2: re-run one test's full beforeEach -> body -> afterEach cycle K times inside one
// runCLI round through jest-circus's retry loop, driven from handleTestEvent.
const { TestEnvironment } = require(require.resolve('jest-environment-node', { paths: [require.resolve('jest', { paths: [process.env.SPIKE_FIXTURE] })] }));
const St = () => globalThis.__spike;
const NEXT = process.env.SPIKE_NEW_ERR ? null : Object.assign(new Error('tzap: next try'), { stack: 'tzap: next try' });
class SpikeEnv extends TestEnvironment {
  async handleTestEvent(event, state) {
    const t = event.test;
    switch (event.name) {
      case 'run_start':
        this.global[Symbol.for('RETRY_TIMES')] = St().tries;
        this.global[Symbol.for('RETRY_IMMEDIATELY')] = true;
        for (const c of state.rootDescribeBlock.children) if (c.type === 'test' && c.name !== 'adds') c.mode = 'skip';
        break;
      case 'test_start':
        // try i: mutant 1 on odd tries, none on even ones.
        this.global.__mutant = process.env.SPIKE_ALL_S ? 0 : (t.invocations - 1) % 2;
        break;
      case 'test_done': {
        const i = t.invocations - 1;
        St().outcomes.push(t.errors.length > 0 ? 'K' : 'S');
        if (i < St().tries - 1) { if (t.errors.length === 0) t.errors.push(NEXT ?? new Error('tzap: next try')); }
        else t.errors = [];
        break;
      }
      case 'run_finish':
        St().hooks = this.global.__hookCounts;
        break;
    }
  }
}
module.exports = SpikeEnv;
