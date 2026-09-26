/**
 * Same result, same bytes: for every reporter, across repeated calls and whatever order the
 * mutants, tests and maps arrive in. Only timings and durations may change the output.
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@tzap/model';
import { reporters } from '../src/index.js';
import { fixture, shuffled } from './fixture.js';

const ctx = { outDir: 'unused', color: true, threshold: 50 };
const render = (r: AnalysisResult) =>
  Object.fromEntries(Object.entries(reporters).map(([name, rep]) => [name, rep(r, ctx)]));

/** Drops the fields allowed to differ between runs. */
function withoutTimings(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutTimings);
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => k !== 'timings' && k !== 'performance' && k !== 'duration')
      .map(([k, x]) => [k, withoutTimings(x)]),
  );
}

describe('determinism', () => {
  it('produces identical bytes from two calls', () => {
    expect(render(fixture())).toEqual(render(fixture()));
  });

  it('does not depend on the input order of mutants, tests or map keys', () => {
    const a = render(fixture());
    const b = render(shuffled(fixture()));
    for (const name of Object.keys(reporters)) expect(b[name], name).toEqual(a[name]);
  });

  it('differs only in timing fields when only timings change', () => {
    const a = render(fixture());
    const b = render(shuffled(fixture(), true));
    for (const name of ['console', 'agent', 'github', 'sarif', 'markdown']) expect(b[name], name).toEqual(a[name]);
    for (const name of ['json', 'elements']) {
      expect(b[name]!.file, name).not.toEqual(a[name]!.file);
      expect(withoutTimings(JSON.parse(b[name]!.file!)), name).toEqual(withoutTimings(JSON.parse(a[name]!.file!)));
    }
  });

  it('does not modify its input', () => {
    const r = fixture();
    const before = JSON.stringify(r);
    render(shuffled(r));
    render(r);
    expect(JSON.stringify(r)).toBe(before);
  });
});
