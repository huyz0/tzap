import { describe, expect, it } from 'vitest';
import { findToken, LineIndex, skipTrivia, truncate } from '../src/text.js';

describe('LineIndex', () => {
  it('counts lines ended by LF, CRLF and a lone CR alike', () => {
    const source = 'a\nbb\r\nccc\rd';
    const lines = new LineIndex(source);
    expect(['a', 'bb', 'ccc', 'd'].map((t) => lines.position(source.indexOf(t)))).toEqual([
      { line: 1, column: 1 },
      { line: 2, column: 1 },
      { line: 3, column: 1 },
      { line: 4, column: 1 },
    ]);
    expect(lines.position(source.indexOf('c') + 2)).toEqual({ line: 3, column: 3 });
  });

  it('maps a line and column back to the offset it came from', () => {
    const source = 'first\r\nsecond\nthird';
    const lines = new LineIndex(source);
    for (let offset = 0; offset < source.length; offset++) {
      const { line, column } = lines.position(offset);
      expect(lines.offset(line, column)).toBe(offset);
    }
  });

  it('places a line past the end at the end of the source', () => {
    expect(new LineIndex('ab').offset(5, 1)).toBe(2);
  });
});

describe('findToken', () => {
  it('finds an operator past comments that contain it', () => {
    const source = 'a /* + */ // +\n + b';
    expect(findToken(source, '+', 1, source.length)).toBe(source.lastIndexOf('+'));
  });

  it('gives -1 when the token is only in a comment, or the comment never ends', () => {
    expect(findToken('a // +', '+', 1, 6)).toBe(-1);
    expect(findToken('a /* + ', '+', 1, 7)).toBe(-1);
  });
});

describe('skipTrivia', () => {
  it('skips whitespace and both kinds of comment', () => {
    const source = '  // one\n  /* two */  x';
    expect(skipTrivia(source, 0)).toBe(source.indexOf('x'));
  });

  it('reaches the end on a comment that runs to it', () => {
    expect(skipTrivia('  // tail', 0)).toBe(9);
    expect(skipTrivia(' /* open', 0)).toBe(8);
  });
});

describe('truncate', () => {
  it('keeps text up to 200 characters, and cuts longer text to 200 with an ellipsis', () => {
    expect(truncate('x'.repeat(200))).toBe('x'.repeat(200));
    const cut = truncate('y'.repeat(201));
    expect(cut).toHaveLength(200);
    expect(cut.endsWith('...')).toBe(true);
  });
});
