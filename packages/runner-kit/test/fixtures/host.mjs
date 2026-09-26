// A host for the session tests, steered by the package environment the test gives it.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { serveHost } from '../../dist/index.js';

serveHost({
  label: 'the test host',
  progressName: 'kit-test',
  init({ options: o, progress }) {
    const env = process.env;
    if (env.KIT_FAIL_INIT) throw new Error('cannot start');
    const executor = {
      listFiles() {
        if (env.KIT_DIE_ON_LIST) process.exit(3);
        return ['a.test.js'];
      },
      async run(req) {
        if (env.KIT_HANG) {
          progress?.(req.id, 'hangs', 5, false);
          for (;;);
        }
        if (env.KIT_FAIL_RUN) throw new Error('run failed');
        return { id: req.id, tests: [{ id: String(process.pid), name: 'pid', file: '', state: 'pass', duration: 0 }], files: [], durationMs: 0 };
      },
      async close() {
        writeFileSync(path.join(o.tmpDir, `closed-${process.pid}`), '');
      },
    };
    return { executor, version: '1.2.3', ...(env.KIT_READY_EXTRA ? { isolatesFiles: true, threads: true } : {}) };
  },
});
