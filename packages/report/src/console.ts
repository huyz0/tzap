import { score, type AnalysisResult } from '@tzap/model';
import { byFile, byTest, describe, pct, sorted, sourceLines, type ReportContext } from './util.js';

/** Lines of a multi-line original shown under a survivor before the rest is summarised. */
const SNIPPET_LINES = 3;

/**
 * The terminal summary, after jzap's. Leads with surviving mutants rather than the score, because
 * the survivors are the actionable part; ends with counts and the two percentages. No timings, so
 * the output is byte-identical between runs.
 */
export function consoleReport(result: AnalysisResult, ctx: Pick<ReportContext, 'color' | 'threshold'>): string {
  const paint = (code: number) => (s: string) => (ctx.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const [bold, dim, red, green, yellow] = [paint(1), paint(2), paint(31), paint(32), paint(33)];
  const out: string[] = [];
  const line = sourceLines(result);

  if (result.redTests.length > 0) {
    // First: a mutant these tests cover would have looked killed for the wrong reason.
    out.push('', yellow(`${result.redTests.length} tests failed without any mutant and were excluded:`));
    for (const t of [...result.redTests].sort(byTest)) {
      out.push(`  ${t.name} (${t.file}): ${t.message.split(/\r?\n/)[0] ?? ''}`);
    }
  }

  const survivors = sorted(result.mutants, 'Survived');
  if (survivors.length > 0) {
    out.push('', bold(`Surviving mutants (${survivors.length}):`));
    for (const [file, mutants] of byFile(survivors)) {
      out.push(`  ${file}`);
      for (const m of mutants) {
        const { start, end } = m.location;
        out.push(`    line ${start.line}: ${describe(m)} ${red(`[${m.mutatorName}]`)}`);
        const last = Math.min(end.line, start.line + SNIPPET_LINES - 1);
        const snippet: string[] = [];
        for (let l = start.line; l <= last; l++) snippet.push(line(file, l) ?? '');
        // Dedented as a block, so a multi-line original keeps its shape.
        const indent = Math.min(...snippet.filter((c) => c.trim()).map((c) => c.length - c.trimStart().length));
        for (const c of snippet) if (c.trim()) out.push(dim(`      ${c.slice(indent).trimEnd()}`));
        if (end.line > last) out.push(dim(`      ... (${end.line - last} more lines)`));
      }
    }
  }

  const s = score(result.mutants);
  const c = result.config;
  out.push('', `Engine: ${c.engine}, typecheck: ${c.typecheck}, scope: ${c.scope}, tests: ${result.tests.length}`, '');
  const row = (label: string, n: number, paintIt = (x: string) => x) => out.push(`  ${label.padEnd(14)}${paintIt(String(n).padStart(6))}`);
  row('killed', s.killed, green);
  row('survived', s.survived, s.survived > 0 ? red : undefined);
  row('timeout', s.timeout);
  row('no coverage', s.noCoverage, s.noCoverage > 0 ? yellow : undefined);
  row('compile error', s.compileError);
  row('runtime error', s.runtimeError, s.runtimeError > 0 ? red : undefined);
  row('ignored', s.ignored);
  if (s.pending > 0) row('pending', s.pending);
  out.push(`  ${'-'.repeat(20)}`);
  row('total', s.total);

  const passing = ctx.threshold === undefined ? s.mutationScore >= 80 : s.mutationScore >= ctx.threshold;
  const scoreText = (passing ? green : ctx.threshold === undefined && s.mutationScore >= 60 ? yellow : red)(pct(s.mutationScore));
  out.push('', `${bold('Mutation score')} ${scoreText} (test strength ${pct(s.mutationScoreBasedOnCoveredCode)}, ignoring uncovered mutants)`);
  if (ctx.threshold !== undefined) out.push(`Threshold ${pct(ctx.threshold)}: ${passing ? green('passed') : red('failed')}`);
  if (s.invalid > 0) {
    // Named so the figures add up: in the total, in neither percentage.
    out.push(`  ${s.invalid} of ${s.total} mutants are outside both figures (compile or runtime error): the tests were never given the chance to detect them.`);
  }
  return `${out.join('\n')}\n`;
}
