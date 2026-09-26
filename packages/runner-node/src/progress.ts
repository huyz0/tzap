import path from 'node:path';

/** Where a host process writes its progress file. */
export const progressDir = (tmpDir: string, pid: number | undefined) => path.join(tmpDir, `node-test-progress-${pid ?? 0}`);
