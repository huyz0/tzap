import type { AnalysisResult } from '@tzap/model';
import { describe, inRepository, sorted, type ReportContext } from './util.js';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

/** A relative path as a URI reference: each segment percent-encoded, so spaces and `#` survive. */
function uri(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * SARIF 2.1.0 for GitHub code scanning: one rule per mutator seen in the run, one warning per
 * surviving mutant. The stable mutant id is the fingerprint, so code scanning tracks a survivor
 * across commits rather than re-opening it whenever lines above it move.
 */
export function sarifReport(result: AnalysisResult, ctx: Pick<ReportContext, 'repositoryPrefix'> = {}) {
  const mutators = [...new Set(result.mutants.map((m) => m.mutatorName))].sort();
  const index = new Map(mutators.map((name, i) => [name, i]));
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'tzap',
            version: result.tzapVersion,
            rules: mutators.map((name) => ({
              id: name,
              name,
              shortDescription: { text: `Surviving ${name} mutant` },
              fullDescription: {
                text: `This ${name} mutation of the code was not detected: no test failed with the change applied.`,
              },
              defaultConfiguration: { level: 'warning' },
            })),
          },
        },
        results: sorted(result.mutants, 'Survived').map((m) => ({
          ruleId: m.mutatorName,
          ruleIndex: index.get(m.mutatorName),
          level: 'warning',
          message: { text: `${describe(m)}: no test failed with this change applied.` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: uri(inRepository(m.file, ctx)), uriBaseId: '%SRCROOT%' },
                region: {
                  startLine: m.location.start.line,
                  startColumn: m.location.start.column,
                  endLine: m.location.end.line,
                  endColumn: m.location.end.column,
                },
              },
            },
          ],
          partialFingerprints: { tzapMutantId: m.id },
        })),
      },
    ],
  };
}

export function sarifJson(result: AnalysisResult, ctx: Pick<ReportContext, 'repositoryPrefix'> = {}): string {
  return `${JSON.stringify(sarifReport(result, ctx), null, 2)}\n`;
}
