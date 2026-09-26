import { expect, it } from 'vitest';
import { slug } from '../src/constants';

// The expected value comes from the code under test, computed while the file loads. Under any
// mutation of slug() both sides change together and this test passes: those mutants survive. An
// engine that activated the mutant only inside the test would report them killed.
const expected = slug(' Tea ');

it('slugs consistently', () => {
  expect(slug(' Tea ')).toBe(expected);
});
