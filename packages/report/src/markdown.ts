import { meetsThreshold, score, type AnalysisResult } from '@tzap/model';
import { byFile, describe, pct, sorted, type ReportContext } from './util.js';

/** Survivor rows listed before the rest are summarised; a PR comment is not the full report. */
export const MARKDOWN_ROW_LIMIT = 50;

/** Table-cell text: one line, no column breaks, no HTML. */
function cell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|');
}

/** A code span; a double fence when the text holds a backtick. */
function code(s: string): string {
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
}

/** A pull-request comment: the score table, and the survivors per file folded away. */
export function markdownReport(result: AnalysisResult, ctx: Pick<ReportContext, 'threshold'> = {}): string {
  const s = score(result.mutants);
  const out = [
    '## tzap mutation testing',
    '',
    '| Mutation score | Test strength | Killed | Survived | No coverage | Timeout | Compile error | Runtime error | Ignored | Total |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| **${pct(s.mutationScore)}** | ${pct(s.mutationScoreBasedOnCoveredCode)} | ${s.killed} | ${s.survived} | ${s.noCoverage} | ${s.timeout} | ${s.compileError} | ${s.runtimeError} | ${s.ignored} | ${s.total} |`,
  ];
  if (ctx.threshold !== undefined) {
    const passed = meetsThreshold(s.mutationScore, ctx.threshold);
    out.push('', `Threshold ${pct(ctx.threshold)}: **${passed ? 'passed' : 'failed'}**`);
  }
  if (result.redTests.length > 0) {
    out.push('', `> **${result.redTests.length} tests failed without any mutant and were excluded.** Fix them before trusting these verdicts.`);
  }
  const survivors = sorted(result.mutants, 'Survived');
  if (survivors.length > 0) {
    out.push('', '<details>', `<summary>${survivors.length} surviving mutants</summary>`);
    for (const [file, mutants] of byFile(survivors.slice(0, MARKDOWN_ROW_LIMIT))) {
      out.push('', `**${code(file)}**`, '', '| Line | Mutator | Description |', '|---:|---|---|');
      for (const m of mutants) out.push(`| ${m.location.start.line} | ${m.mutatorName} | ${cell(describe(m))} |`);
    }
    if (survivors.length > MARKDOWN_ROW_LIMIT) out.push('', `...and ${survivors.length - MARKDOWN_ROW_LIMIT} more.`);
    out.push('', '</details>');
  }
  return `${out.join('\n')}\n`;
}
