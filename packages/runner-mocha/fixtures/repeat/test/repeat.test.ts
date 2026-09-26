import assert from 'node:assert/strict';
import { isFree } from '../src/free.ts';

// Both fail when run a second time; only the one that reaches a mutant is repeated.
const runs: Record<string, number> = {};
const once = (k: string) => {
  runs[k] = (runs[k] ?? 0) + 1;
  assert.equal(runs[k], 1);
};

it('reaches a mutant once', () => {
  assert.equal(isFree(0), true);
  once('a');
});

it('reaches no mutant once', () => {
  once('b');
});
