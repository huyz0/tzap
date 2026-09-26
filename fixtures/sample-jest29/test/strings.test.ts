import { joinNames } from '../src/strings';

it('joins non-blank names', () => {
  expect(joinNames(['a', ' ', 'b'])).toBe('a, b');
});
