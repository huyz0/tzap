import { before, test } from 'node:test';

before(() => {
  throw new Error('no database');
});

test('needs the database', () => {});
