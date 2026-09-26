import { languageOf, type AnalysisResult } from '@tzap/model';
import { byFile, byTest, ordered, SCORE_THRESHOLDS, sorted, sortedKeys } from './util.js';

/** The mutation-testing-elements report schema major this writer targets (package version 3.9.0). */
export const ELEMENTS_SCHEMA_VERSION = '2';

const MUTANT_KEYS = [
  'id', 'mutatorName', 'replacement', 'location', 'status', 'statusReason', 'static', 'coveredBy', 'killedBy',
  'testsCompleted', 'duration', 'description',
];

/**
 * The mutation-testing-elements report: Stryker's HTML viewer and dashboard read it unchanged.
 * tzap's statuses are the schema's own, so this is a reshaping, never a translation.
 */
export function elementsReport(result: AnalysisResult) {
  const grouped = byFile(sorted(result.mutants));
  const paths = [...new Set([...Object.keys(result.files), ...grouped.keys()])].sort();
  const files = Object.fromEntries(
    paths.map((path) => [
      path,
      {
        language: result.files[path]?.language ?? languageOf(path),
        source: result.files[path]?.source ?? '',
        mutants: (grouped.get(path) ?? []).map((m) =>
          ordered(
            {
              id: m.id,
              mutatorName: m.mutatorName,
              replacement: m.replacement,
              location: {
                start: { line: m.location.start.line, column: m.location.start.column },
                end: { line: m.location.end.line, column: m.location.end.column },
              },
              status: m.status,
              statusReason: m.statusReason,
              static: m.static,
              coveredBy: m.coveredBy && [...m.coveredBy].sort(),
              killedBy: m.killedBy && [...m.killedBy].sort(),
              testsCompleted: m.testsCompleted,
              duration: m.duration,
              description: m.description,
            },
            MUTANT_KEYS,
          ),
        ),
      },
    ]),
  );

  const testFiles: Record<string, { tests: Array<{ id: string; name: string }> }> = {};
  for (const t of [...result.tests].sort(byTest)) {
    (testFiles[t.file] ??= { tests: [] }).tests.push({ id: t.id, name: t.name });
  }
  const ms = (...phases: string[]) => phases.reduce((sum, p) => sum + (result.timings[p] ?? 0), 0);

  return {
    schemaVersion: ELEMENTS_SCHEMA_VERSION,
    thresholds: { ...SCORE_THRESHOLDS },
    projectRoot: result.root,
    config: ordered(result.config, ['engine', 'typecheck', 'scope', 'mutators', 'filters']),
    files,
    testFiles: Object.fromEntries(sortedKeys(testFiles).map((k) => [k, testFiles[k]!])),
    framework: { name: 'tzap', version: result.tzapVersion },
    performance: { setup: ms('instrument'), initialRun: ms('coverage'), mutation: ms('execute', 'static') },
  };
}

export function elementsJson(result: AnalysisResult): string {
  return `${JSON.stringify(elementsReport(result), null, 2)}\n`;
}
