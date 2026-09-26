import { after, test } from 'node:test';

after(() => {
  throw new Error('cleanup failed');
});

test('passes before a broken cleanup', () => {});
