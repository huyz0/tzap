import { score, type AnalysisResult } from '@tzap/model';
import { describe, pct, sorted } from './util.js';

/** GitHub shows at most this many annotations of one level from one step; the rest are dropped silently. */
export const GITHUB_ANNOTATION_LIMIT = 10;

/** Workflow-command message escaping. */
export function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Property values additionally escape the characters that delimit properties. */
export function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * GitHub Actions workflow-command annotations, one warning per surviving mutant, ranked by file
 * then line and capped at GitHub's per-step limit; a closing notice says how many were left out
 * rather than letting GitHub drop them without a word. Uncovered mutants are not annotated: a
 * review comment on untested code is a coverage conversation, not a mutation one.
 */
export function githubReport(result: AnalysisResult): string {
  const survivors = sorted(result.mutants, 'Survived');
  const out = survivors.slice(0, GITHUB_ANNOTATION_LIMIT).map((m) => {
    const { start, end } = m.location;
    const props = [
      `file=${escapeProperty(m.file)}`,
      `line=${start.line}`,
      `col=${start.column}`,
      `endLine=${end.line}`,
      `endColumn=${end.column}`,
      `title=${escapeProperty(`Surviving mutant (${m.mutatorName})`)}`,
    ];
    return `::warning ${props.join(',')}::${escapeData(describe(m))}`;
  });
  const s = score(result.mutants);
  const omitted = survivors.length - out.length;
  out.push(
    `::notice::${escapeData(
      `tzap: ${survivors.length} surviving mutants, mutation score ${pct(s.mutationScore)}` +
        (omitted > 0 ? `; ${omitted} not annotated (GitHub shows at most ${GITHUB_ANNOTATION_LIMIT} per step), see the full report` : ''),
    )}`,
  );
  return `${out.join('\n')}\n`;
}
