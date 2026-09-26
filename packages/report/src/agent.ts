import { score, type AnalysisResult, type MutantStatus } from '@tzap/model';
import { byFile, byTest, describe, pct, sorted } from './util.js';

/**
 * The findings and nothing else, for a coding agent reading command output: jzap's shape, which
 * measured 16 KB against 509 KB of JSON for the same findings. No killed mutants (nothing to do),
 * no snippets (`path` and line are enough to open the file), no timings (not actionable).
 * Headline first and survivors before uncovered, so a read truncated anywhere keeps the most
 * useful part. Ignored mutants are not findings and appear nowhere, including the total.
 */
export function agentReport(result: AnalysisResult): string {
  const s = score(result.mutants);
  const out = [
    `tzap: ${s.survived} survived, ${s.noCoverage} uncovered of ${s.total - s.ignored} mutants ` +
      `(score ${pct(s.mutationScore)}, strength ${pct(s.mutationScoreBasedOnCoveredCode)})`,
  ];
  if (result.redTests.length > 0) {
    // Not abbreviated, as in jzap: every verdict below is suspect until these are fixed.
    out.push('', `baseline-failures: ${result.redTests.length} tests fail with no mutant applied and were excluded`);
    for (const t of [...result.redTests].sort(byTest)) out.push(`  ${t.file} ${t.name}`);
  }
  const section = (heading: string, status: MutantStatus) => {
    const groups = byFile(sorted(result.mutants, status));
    if (groups.size === 0) return;
    out.push('', `${heading}:`);
    for (const [file, mutants] of groups) {
      out.push(file);
      for (const m of mutants) out.push(`  ${m.location.start.line} ${m.mutatorName} ${describe(m)}`);
    }
  };
  section('survived', 'Survived');
  section('uncovered', 'NoCoverage');
  return `${out.join('\n')}\n`;
}
