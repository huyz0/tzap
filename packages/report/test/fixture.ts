/**
 * A hand-built analysis covering every status, static and ignored mutants, a red test, a mutant
 * whose original spans lines, a path with spaces, and text that each format must escape.
 */
import type { AnalysisResult, MutantResult, MutantStatus } from '@tzap/model';

const MATH = `export function add(a: number, b: number): number {
  return a + b;
}

export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  return x > hi ? hi : x;
}

export const LIMIT = 10 * 2;

export function describe(x: number): string {
  return x > 0
    ? 'positive'
    : 'other';
}
`;

const FORMAT = `export function pad(s: string, n: number): string {
  return s.length < n ? s + ' '.repeat(n - s.length) : s;
}
`;

export const MATH_FILE = 'src/math.ts';
export const FORMAT_FILE = 'src/my utils/format util.ts';

let seq = 0;
function mutant(
  file: string,
  status: MutantStatus,
  line: number,
  column: number,
  mutatorName: string,
  original: string,
  replacement: string,
  extra: Partial<MutantResult> = {},
): MutantResult {
  const lines = original.split('\n');
  const endLine = line + lines.length - 1;
  const endColumn = lines.length === 1 ? column + original.length : (lines.at(-1) as string).length + 1;
  seq++;
  return {
    id: `h${(seq * 2654435761) % 4294967296}`,
    num: seq,
    file,
    mutatorName,
    location: { start: { line, column }, end: { line: endLine, column: endColumn } },
    original,
    replacement,
    site: seq,
    status,
    ...extra,
  };
}

export function fixture(): AnalysisResult {
  seq = 0;
  const mutants: MutantResult[] = [
    mutant(MATH_FILE, 'Killed', 2, 10, 'ArithmeticOperator', 'a + b', 'a - b', {
      description: 'Replaced a + b with a - b',
      coveredBy: ['t2', 't1'],
      killedBy: ['t1'],
      testsCompleted: 1,
      duration: 12,
      statusReason: 'expected 3 to be -1',
    }),
    mutant(MATH_FILE, 'Survived', 6, 7, 'EqualityOperator', 'x < lo', 'x <= lo', {
      description: 'Changed < to <= (boundary)',
      coveredBy: ['t1', 't2'],
      testsCompleted: 2,
      duration: 20,
    }),
    mutant(MATH_FILE, 'Survived', 6, 7, 'ConditionalExpression', 'x < lo', 'false', {
      description: 'Replaced x < lo with false',
      coveredBy: ['t2'],
      testsCompleted: 1,
    }),
    mutant(MATH_FILE, 'Timeout', 7, 10, 'EqualityOperator', 'x > hi', 'x >= hi', {
      description: 'Changed > to >=',
      coveredBy: ['t2'],
      statusReason: 'loop guard tripped',
    }),
    // Static: reached only while the module evaluated.
    mutant(MATH_FILE, 'Survived', 10, 22, 'ArithmeticOperator', '10 * 2', '10 / 2', {
      description: 'Replaced 10 * 2 with 10 / 2',
      static: true,
      coveredBy: [],
      testsCompleted: 3,
    }),
    mutant(MATH_FILE, 'Killed', 10, 22, 'ArithmeticOperator', '10 * 2', '10 + 2', { static: true, killedBy: ['t3'] }),
    // A multi-line original.
    mutant(MATH_FILE, 'Survived', 13, 10, 'ConditionalExpression', "x > 0\n    ? 'positive'\n    : 'other'", "'other'", {
      description: 'Replaced the conditional with its alternate',
      coveredBy: ['t1'],
    }),
    mutant(MATH_FILE, 'NoCoverage', 14, 7, 'StringLiteral', "'positive'", '""', { description: 'Emptied a string, 100% sure, a:b' }),
    mutant(MATH_FILE, 'CompileError', 7, 10, 'ConditionalExpression', 'x > hi', 'true', {
      description: 'Replaced x > hi with true',
      statusReason: "TS2367: This comparison appears to be unintentional",
    }),
    mutant(MATH_FILE, 'RuntimeError', 5, 1, 'BlockStatement', '{', '{}', { statusReason: 'worker crashed' }),
    mutant(MATH_FILE, 'Ignored', 1, 1, 'BlockStatement', '{', '{}', { ignoredBy: 'arid', statusReason: 'arid node' }),
    mutant(FORMAT_FILE, 'Survived', 2, 10, 'EqualityOperator', 's.length < n', 's.length <= n', {
      // Every character a format must escape: newline, %, comma, colon, pipe, angle brackets.
      description: 'Changed < to <= in pad, 50%, a,b: x|y <script>\nsecond line',
      coveredBy: ['t3'],
    }),
    mutant(FORMAT_FILE, 'NoCoverage', 2, 42, 'ArithmeticOperator', 'n - s.length', 'n + s.length'),
    mutant(FORMAT_FILE, 'Pending', 2, 25, 'StringLiteral', "' '", '""'),
  ];
  return {
    tzapVersion: '0.1.0',
    root: '/work/project',
    files: {
      [MATH_FILE]: { language: 'typescript', source: MATH },
      [FORMAT_FILE]: { language: 'typescript', source: FORMAT },
    },
    mutants,
    tests: [
      { id: 't2', name: 'math > clamp', file: 'test/math.test.ts', duration: 3 },
      { id: 't1', name: 'math > add', file: 'test/math.test.ts', duration: 2 },
      { id: 't3', name: 'format > pad', file: 'test/format util.test.ts', duration: 1 },
    ],
    redTests: [
      { id: 't9', name: 'math > flaky', file: 'test/math.test.ts', message: 'expected 1 to be 2\n  at line 9' },
    ],
    config: { engine: 'warm', typecheck: 'survivors', mutators: ['all'], filters: ['arid'], scope: 'full' },
    timings: { instrument: 100, coverage: 250, execute: 900, static: 50, typecheck: 30 },
  };
}

/** The same result with mutants, tests and map keys in a different order; with `retime`, different timings too. */
export function shuffled(result: AnalysisResult, retime = false): AnalysisResult {
  const t = (n: number | undefined, i: number) => (n === undefined || !retime ? n : n + i + 1);
  const mutants: MutantResult[] = [...result.mutants].reverse().map((m, i) => ({ ...m, duration: t(m.duration, i) }));
  // Swap two adjacent mutants as well as reversing, so no order-preserving bug hides behind symmetry.
  [mutants[0], mutants[1]] = [mutants[1] as MutantResult, mutants[0] as MutantResult];
  const reverseKeys = <V>(o: Record<string, V>) => Object.fromEntries(Object.entries(o).reverse());
  return {
    ...result,
    files: reverseKeys(result.files),
    mutants,
    tests: [...result.tests].reverse(),
    timings: reverseKeys(Object.fromEntries(Object.entries(result.timings).map(([k, v]) => [k, retime ? v * 2 : v]))),
  };
}
