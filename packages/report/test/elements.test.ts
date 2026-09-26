/** The elements report against the published mutation-testing-report-schema, validated with ajv. */
import { createRequire } from 'node:module';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { elementsJson, elementsReport } from '../src/index.js';
import { FORMAT_FILE, fixture, MATH_FILE } from './fixture.js';

const require = createRequire(import.meta.url);
const schema = require('mutation-testing-report-schema/mutation-testing-report-schema.json');
// The schema is draft-07; `format: uri` appears only under branding, which tzap does not emit.
const validate = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(schema);

function valid(report: unknown) {
  const ok = validate(report);
  return ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

describe('elements', () => {
  it('validates against the published schema', () => {
    expect(valid(JSON.parse(elementsJson(fixture())))).toEqual([]);
  });

  it('validates with no mutants, no tests and no timings', () => {
    expect(valid(JSON.parse(elementsJson({ ...fixture(), mutants: [], tests: [], timings: {} })))).toEqual([]);
  });

  it('the validator is not vacuous', () => {
    const broken = JSON.parse(elementsJson(fixture()));
    broken.files[MATH_FILE].mutants[0].status = 'Dead';
    delete broken.files[FORMAT_FILE].mutants[0].location;
    expect(valid(broken)).toHaveLength(2);
  });

  it('has the header, framework and performance derived from timings', () => {
    const r = elementsReport(fixture());
    expect(r).toMatchObject({
      schemaVersion: '2',
      thresholds: { high: 80, low: 60 },
      projectRoot: '/work/project',
      framework: { name: 'tzap', version: '0.1.0' },
      performance: { setup: 100, initialRun: 250, mutation: 950 },
    });
  });

  it('keys files by path, with every mutant in report order and undefined fields omitted', () => {
    const r = elementsReport(fixture());
    expect(Object.keys(r.files)).toEqual([MATH_FILE, FORMAT_FILE]);
    const math = r.files[MATH_FILE]!;
    expect(math.language).toBe('typescript');
    expect(math.source).toBe(fixture().files[MATH_FILE]!.source);
    expect(math.mutants.map((m) => `${m.location.start.line}:${m.location.start.column} ${m.status}`)).toEqual([
      '1:1 Ignored', '2:10 Killed', '5:1 RuntimeError', '6:7 Survived', '6:7 Survived', '7:10 CompileError',
      '7:10 Timeout', '10:22 Killed', '10:22 Survived', '13:10 Survived', '14:7 NoCoverage',
    ]);
    const killed = math.mutants[1]!;
    expect(Object.keys(killed)).toEqual([
      'id', 'mutatorName', 'replacement', 'location', 'status', 'statusReason', 'coveredBy', 'killedBy',
      'testsCompleted', 'duration', 'description',
    ]);
    expect(math.mutants.filter((m) => m.static).map((m) => m.status)).toEqual(['Killed', 'Survived']);
    expect(math.mutants[9]!.location).toEqual({ start: { line: 13, column: 10 }, end: { line: 15, column: 14 } });
    expect(Object.keys(r.files[FORMAT_FILE]!.mutants[2]!)).toEqual(['id', 'mutatorName', 'replacement', 'location', 'status']);
  });

  it('groups tests by file, so killedBy and coveredBy resolve', () => {
    const r = elementsReport(fixture());
    expect(r.testFiles).toEqual({
      'test/format util.test.ts': { tests: [{ id: 't3', name: 'format > pad' }] },
      'test/math.test.ts': { tests: [{ id: 't1', name: 'math > add' }, { id: 't2', name: 'math > clamp' }] },
    });
    const ids = new Set(Object.values(r.testFiles).flatMap((f) => f.tests.map((t) => t.id)));
    for (const f of Object.values(r.files)) {
      for (const m of f.mutants) for (const t of [...(m.coveredBy ?? []), ...(m.killedBy ?? [])]) expect(ids).toContain(t);
    }
  });

  it('includes a mutated file missing from `files`, and a file with no mutants', () => {
    const r = fixture();
    r.files['src/untouched.ts'] = { language: 'typescript', source: 'export {};\n' };
    delete r.files[FORMAT_FILE];
    const out = elementsReport(r);
    expect(out.files['src/untouched.ts']!.mutants).toEqual([]);
    expect(out.files[FORMAT_FILE]).toMatchObject({ language: 'typescript', source: '' });
    expect(valid(JSON.parse(JSON.stringify(out)))).toEqual([]);
  });
});
