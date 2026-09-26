import { score, type AnalysisResult, type MutantResult } from '@tzap/model';
import { byTest, ordered, sorted, sortedKeys } from './util.js';

/** Version of the native JSON report. Bumped on any change a reader could notice. */
export const REPORT_SCHEMA_VERSION = 1;

const MUTANT_KEYS = [
  'id', 'num', 'file', 'mutatorName', 'location', 'original', 'replacement', 'description', 'status',
  'statusReason', 'ignoredBy', 'static', 'site', 'coveredBy', 'killedBy', 'testsCompleted', 'duration', 'cached',
];
const TEST_KEYS = ['id', 'name', 'file', 'duration', 'message'];

function mutant(m: MutantResult): MutantResult {
  const pos = (p: MutantResult['location']['start']) => ({ line: p.line, column: p.column });
  return ordered(
    {
      ...m,
      location: { start: pos(m.location.start), end: pos(m.location.end) },
      // Sets, whatever order the scheduler met them in.
      coveredBy: m.coveredBy && [...m.coveredBy].sort(),
      killedBy: m.killedBy && [...m.killedBy].sort(),
    },
    MUTANT_KEYS,
  );
}

/** Keys in the declared order, maps by key, mutants by `compareMutants`: stable whatever the input order. */
export function canonicalResult(result: AnalysisResult) {
  const map = <V>(o: Record<string, V>, f: (v: V) => V = (v) => v) =>
    Object.fromEntries(sortedKeys(o).map((k) => [k, f(o[k] as V)]));
  return ordered(
    {
      ...result,
      schemaVersion: REPORT_SCHEMA_VERSION,
      score: score(result.mutants),
      config: ordered(result.config, ['engine', 'typecheck', 'scope', 'mutators', 'filters']),
      files: map(result.files, (f) => ordered(f, ['language', 'source'])),
      mutants: sorted(result.mutants).map(mutant),
      tests: [...result.tests].sort(byTest).map((t) => ordered(t, TEST_KEYS)),
      redTests: [...result.redTests].sort(byTest).map((t) => ordered(t, TEST_KEYS)),
      timings: map(result.timings),
    },
    ['schemaVersion', 'tzapVersion', 'root', 'config', 'score', 'files', 'mutants', 'tests', 'redTests', 'timings'],
  );
}

/** tzap's native report: the whole `AnalysisResult`, plus `schemaVersion` and the computed `score`. */
export function jsonReport(result: AnalysisResult): string {
  // NaN scores serialise as null, which is what JSON has for "no value".
  return `${JSON.stringify(canonicalResult(result), null, 2)}\n`;
}
