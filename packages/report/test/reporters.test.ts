/**
 * Each reporter against the hand-built fixture. Expected text is written by hand from the formats'
 * specifications (jzap's console and agent shapes, GitHub's workflow commands, SARIF 2.1.0).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisResult, MutantResult } from '@tzap/model';
import { describe, expect, it } from 'vitest';
import {
  agentReport,
  consoleReport,
  elementsBundle,
  elementsReport,
  GITHUB_ANNOTATION_LIMIT,
  githubReport,
  htmlReport,
  jsonReport,
  MARKDOWN_ROW_LIMIT,
  markdownReport,
  REPORT_FILES,
  reporters,
  sarifReport,
  writeReports,
} from '../src/index.js';
import { escapeData, escapeProperty } from '../src/github.js';
import { FORMAT_FILE, fixture, MATH_FILE } from './fixture.js';

/** A result with `n` survivors spread over two files, listed in reverse report order. */
function manySurvivors(n: number): AnalysisResult {
  const base = fixture();
  const template = base.mutants.find((m) => m.status === 'Survived') as MutantResult;
  const mutants = Array.from({ length: n }, (_, i): MutantResult => ({
    ...template,
    id: `s${i}`,
    num: i,
    file: i % 2 === 0 ? 'b.ts' : 'a,b:c.ts',
    location: { start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 2 } },
    description: `survivor ${i}`,
  })).reverse();
  return { ...base, mutants };
}

describe('console', () => {
  const out = consoleReport(fixture(), { color: false });

  it('leads with the red tests, then survivors grouped by file with their source lines', () => {
    expect(out).toContain(
      [
        '1 tests failed without any mutant and were excluded:',
        '  math > flaky (test/math.test.ts): expected 1 to be 2',
        '',
        'Surviving mutants (5):',
        '  src/math.ts',
        '    line 6: Replaced x < lo with false [ConditionalExpression]',
        '      if (x < lo) return lo;',
        '    line 6: Changed < to <= (boundary) [EqualityOperator]',
        '      if (x < lo) return lo;',
        '    line 10: Replaced 10 * 2 with 10 / 2 [ArithmeticOperator]',
        '      export const LIMIT = 10 * 2;',
        '    line 13: Replaced the conditional with its alternate [ConditionalExpression]',
        '      return x > 0',
        "        ? 'positive'",
        "        : 'other';",
        '  src/my utils/format util.ts',
        '    line 2: Changed < to <= in pad, 50%, a,b: x|y <script> second line [EqualityOperator]',
        "      return s.length < n ? s + ' '.repeat(n - s.length) : s;",
      ].join('\n'),
    );
  });

  it('prints every count, the score and the test strength', () => {
    expect(out).toContain(
      [
        '  killed             2',
        '  survived           5',
        '  timeout            1',
        '  no coverage        2',
        '  compile error      1',
        '  runtime error      1',
        '  ignored            1',
        '  pending            1',
        '  --------------------',
        '  total             14',
        '',
        'Mutation score 30.0% (test strength 37.5%, ignoring uncovered mutants)',
      ].join('\n'),
    );
    expect(out).toContain('Engine: warm, typecheck: survivors, scope: full, tests: 3');
    expect(out).toContain('2 of 14 mutants are outside both figures');
  });

  it('colours only when asked, and states the threshold verdict', () => {
    expect(out).not.toContain('\x1b[');
    const coloured = consoleReport(fixture(), { color: true, threshold: 25 });
    expect(coloured).toContain('\x1b[31m[EqualityOperator]\x1b[0m');
    expect(coloured).toContain('Threshold 25.0%: \x1b[32mpassed\x1b[0m');
    // Stripped of colour, it is the plain report plus the threshold line.
    expect(coloured.replace(/\x1b\[\d+m/g, '')).toBe(out.replace(/(ignoring uncovered mutants\)\n)/, '$1Threshold 25.0%: passed\n'));
  });

  it('shows n/a for a result with nothing to score, and no survivor section', () => {
    const empty = consoleReport({ ...fixture(), mutants: [], redTests: [] }, { color: false });
    expect(empty).toContain('Mutation score n/a (test strength n/a, ignoring uncovered mutants)');
    expect(empty).not.toContain('Surviving');
    expect(empty).not.toContain('tests failed');
  });

  it('summarises a long multi-line original after three lines', () => {
    const r = fixture();
    const m = r.mutants.find((x) => x.location.start.line === 13) as MutantResult;
    m.location = { start: { line: 12, column: 1 }, end: { line: 16, column: 2 } };
    expect(consoleReport(r, { color: false })).toContain(
      ['      export function describe(x: number): string {', '        return x > 0', "          ? 'positive'", '      ... (2 more lines)'].join('\n'),
    );
  });
});

describe('agent', () => {
  it("is jzap's shape exactly: headline, red tests, survivors and uncovered by file and line", () => {
    expect(agentReport(fixture())).toBe(
      [
        'tzap: 5 survived, 2 uncovered of 13 mutants (score 30.0%, strength 37.5%)',
        '',
        'baseline-failures: 1 tests fail with no mutant applied and were excluded',
        '  test/math.test.ts math > flaky',
        '',
        'survived:',
        'src/math.ts',
        '  6 ConditionalExpression Replaced x < lo with false',
        '  6 EqualityOperator Changed < to <= (boundary)',
        '  10 ArithmeticOperator Replaced 10 * 2 with 10 / 2',
        '  13 ConditionalExpression Replaced the conditional with its alternate',
        'src/my utils/format util.ts',
        '  2 EqualityOperator Changed < to <= in pad, 50%, a,b: x|y <script> second line',
        '',
        'uncovered:',
        'src/math.ts',
        '  14 StringLiteral Emptied a string, 100% sure, a:b',
        'src/my utils/format util.ts',
        '  2 ArithmeticOperator replaced n - s.length with n + s.length',
        '',
      ].join('\n'),
    );
  });

  it('is one line when there is nothing to act on', () => {
    const r = fixture();
    const clean = { ...r, redTests: [], mutants: r.mutants.filter((m) => m.status === 'Killed' || m.status === 'Ignored') };
    expect(agentReport(clean)).toBe('tzap: 0 survived, 0 uncovered of 2 mutants (score 100.0%, strength 100.0%)\n');
  });
});

describe('github', () => {
  it('annotates each survivor with its span and mutator, then a summary notice', () => {
    expect(githubReport(fixture())).toBe(
      [
        '::warning file=src/math.ts,line=6,col=7,endLine=6,endColumn=13,title=Surviving mutant (ConditionalExpression)::Replaced x < lo with false',
        '::warning file=src/math.ts,line=6,col=7,endLine=6,endColumn=13,title=Surviving mutant (EqualityOperator)::Changed < to <= (boundary)',
        '::warning file=src/math.ts,line=10,col=22,endLine=10,endColumn=28,title=Surviving mutant (ArithmeticOperator)::Replaced 10 * 2 with 10 / 2',
        '::warning file=src/math.ts,line=13,col=10,endLine=15,endColumn=14,title=Surviving mutant (ConditionalExpression)::Replaced the conditional with its alternate',
        '::warning file=src/my utils/format util.ts,line=2,col=10,endLine=2,endColumn=22,title=Surviving mutant (EqualityOperator)::Changed < to <= in pad, 50%25, a,b: x|y <script> second line',
        '::notice::tzap: 5 surviving mutants, mutation score 30.0%25',
        '',
      ].join('\n'),
    );
  });

  it("stops at GitHub's per-step limit, ranked by file then line, and says how many were left out", () => {
    const lines = githubReport(manySurvivors(13)).trimEnd().split('\n');
    const warnings = lines.filter((l) => l.startsWith('::warning '));
    expect(warnings).toHaveLength(GITHUB_ANNOTATION_LIMIT);
    // `a,b:c.ts` sorts first; its property value is escaped.
    expect(warnings[0]).toMatch(/^::warning file=a%2Cb%3Ac\.ts,line=2,/);
    expect(warnings.map((w) => /file=([^,]+),line=(\d+)/.exec(w)?.slice(1).join(':'))).toEqual([
      'a%2Cb%3Ac.ts:2', 'a%2Cb%3Ac.ts:4', 'a%2Cb%3Ac.ts:6', 'a%2Cb%3Ac.ts:8', 'a%2Cb%3Ac.ts:10', 'a%2Cb%3Ac.ts:12',
      'b.ts:1', 'b.ts:3', 'b.ts:5', 'b.ts:7',
    ]);
    expect(lines.at(-1)).toBe(
      '::notice::tzap: 13 surviving mutants, mutation score 0.0%25; 3 not annotated (GitHub shows at most 10 per step), see the full report',
    );
    expect(lines).toHaveLength(11);
  });

  it("escapes data and properties by GitHub's rules", () => {
    expect(escapeData('50% a\r\nb, c: d')).toBe('50%25 a%0D%0Ab, c: d');
    expect(escapeProperty('50% a\r\nb, c: d')).toBe('50%25 a%0D%0Ab%2C c%3A d');
    // `%` first, so an escape is never escaped twice.
    expect(escapeData('%0A')).toBe('%250A');
  });
});

describe('sarif', () => {
  const sarif = sarifReport(fixture());
  const run = sarif.runs[0] as (typeof sarif.runs)[number];

  it('has the SARIF 2.1.0 required structure', () => {
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toMatch(/sarif-2\.1\.0/);
    expect(sarif.runs).toHaveLength(1);
    expect(run.tool.driver.name).toBe('tzap');
    for (const rule of run.tool.driver.rules) {
      expect(rule.id).toMatch(/^\w+$/);
      expect(rule.shortDescription.text).toBeTruthy();
    }
    for (const r of run.results) {
      expect(r.message.text).toBeTruthy();
      expect(r.level).toBe('warning');
      expect(run.tool.driver.rules[r.ruleIndex as number]?.id).toBe(r.ruleId);
      const { region, artifactLocation } = r.locations[0]!.physicalLocation;
      expect(artifactLocation.uri).not.toMatch(/[ \\]/);
      expect(region.startLine).toBeGreaterThanOrEqual(1);
      expect(region.startColumn).toBeGreaterThanOrEqual(1);
      expect(region.endLine).toBeGreaterThanOrEqual(region.startLine);
    }
  });

  it('has one rule per mutator and one result per survivor', () => {
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual([
      'ArithmeticOperator', 'BlockStatement', 'ConditionalExpression', 'EqualityOperator', 'StringLiteral',
    ]);
    expect(run.results.map((r) => `${r.locations[0]!.physicalLocation.artifactLocation.uri}:${r.locations[0]!.physicalLocation.region.startLine} ${r.ruleId}`)).toEqual([
      'src/math.ts:6 ConditionalExpression',
      'src/math.ts:6 EqualityOperator',
      'src/math.ts:10 ArithmeticOperator',
      'src/math.ts:13 ConditionalExpression',
      'src/my%20utils/format%20util.ts:2 EqualityOperator',
    ]);
    expect(run.results[3]!.locations[0]!.physicalLocation.region).toEqual({ startLine: 13, startColumn: 10, endLine: 15, endColumn: 14 });
    expect(new Set(run.results.map((r) => r.partialFingerprints.tzapMutantId)).size).toBe(5);
  });
});

describe('markdown', () => {
  it('has the score table and the survivors folded per file, escaped for table cells', () => {
    const md = markdownReport(fixture(), { threshold: 70 });
    expect(md).toContain('| **30.0%** | 37.5% | 2 | 5 | 2 | 1 | 1 | 1 | 1 | 14 |');
    expect(md).toContain('Threshold 70.0%: **failed**');
    expect(md).toContain('<summary>5 surviving mutants</summary>');
    expect(md).toContain('**`src/my utils/format util.ts`**');
    expect(md).toContain('| 2 | EqualityOperator | Changed &lt; to &lt;= in pad, 50%, a,b: x\\|y &lt;script&gt; second line |');
    expect(md).toContain('1 tests failed without any mutant');
    expect(md.match(/<details>/g)).toHaveLength(1);
    expect(md.match(/<\/details>/g)).toHaveLength(1);
  });

  it(`lists at most ${MARKDOWN_ROW_LIMIT} survivors, then says how many more`, () => {
    const md = markdownReport(manySurvivors(57));
    expect(md.split('\n').filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(MARKDOWN_ROW_LIMIT);
    expect(md).toContain('...and 7 more.');
  });

  it('omits the details block when nothing survived', () => {
    expect(markdownReport({ ...fixture(), mutants: [] })).not.toContain('<details>');
  });
});

describe('json', () => {
  const json = JSON.parse(jsonReport(fixture()));

  it('is the analysis result, versioned, with the score added', () => {
    expect(Object.keys(json)).toEqual(['schemaVersion', 'tzapVersion', 'root', 'config', 'score', 'files', 'mutants', 'tests', 'redTests', 'timings']);
    expect(json.schemaVersion).toBe(1);
    expect(json.score).toMatchObject({ total: 14, killed: 2, survived: 5, mutationScore: 30, mutationScoreBasedOnCoveredCode: 37.5 });
    expect(json.mutants).toHaveLength(14);
    expect(json.redTests[0].message).toBe('expected 1 to be 2\n  at line 9');
    expect(Object.keys(json.files)).toEqual([MATH_FILE, FORMAT_FILE]);
    expect(Object.keys(json.timings)).toEqual(['coverage', 'execute', 'instrument', 'static', 'typecheck']);
  });

  it('keeps every mutant field, in declaration order, and sorts id sets', () => {
    const killed = json.mutants.find((m: MutantResult) => m.status === 'Killed' && m.killedBy?.[0] === 't1');
    expect(Object.keys(killed)).toEqual([
      'id', 'num', 'file', 'mutatorName', 'location', 'original', 'replacement', 'description', 'status',
      'statusReason', 'site', 'coveredBy', 'killedBy', 'testsCompleted', 'duration',
    ]);
    expect(killed.coveredBy).toEqual(['t1', 't2']);
    const ignored = json.mutants.find((m: MutantResult) => m.status === 'Ignored');
    expect(ignored).toMatchObject({ ignoredBy: 'arid', statusReason: 'arid node' });
    expect(json.mutants.filter((m: MutantResult) => m.static)).toHaveLength(2);
  });

  it('writes a NaN score as null', () => {
    expect(JSON.parse(jsonReport({ ...fixture(), mutants: [] })).score.mutationScore).toBeNull();
  });
});

describe('html', () => {
  it('embeds the elements component and the elements report in one page', () => {
    const html = htmlReport(fixture());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<mutation-test-report-app title-postfix="tzap">');
    // The whole component bundle inline; `toBe` keeps a failure from printing 240 KB.
    expect(html.includes(elementsBundle())).toBe(true);
    expect(elementsBundle()).toMatch(/mutation-test-report-app/);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    const embedded = /\.report = (.*);\n<\/script>/.exec(html)?.[1];
    expect(JSON.parse(embedded as string)).toEqual(JSON.parse(JSON.stringify(elementsReport(fixture()))));
  });

  it('cannot be broken out of by source text or by the bundle', () => {
    const r = fixture();
    (r.files[MATH_FILE] as { source: string }).source += '// </script><script>alert(1)</script>\n';
    const html = htmlReport(r, 'var x = "</script>";');
    // Exactly the two closing tags the page itself writes.
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).toContain('var x = "<\\/script>";');
  });
});

describe('writeReports', () => {
  it('writes each file-producing reporter to its file and returns what the others print', () => {
    const outDir = join(mkdtempSync(join(tmpdir(), 'tzap-report-')), 'nested out');
    const stdout = writeReports(fixture(), ['json', 'console', 'elements', 'html', 'sarif', 'markdown', 'agent', 'github'], { outDir, color: false });
    expect(readdirSync(outDir).sort()).toEqual(['mutation.html', 'mutation.json', 'tzap.json', 'tzap.md', 'tzap.sarif']);
    expect(stdout).toBe(consoleReport(fixture(), { color: false }) + agentReport(fixture()) + githubReport(fixture()));
    expect(readFileSync(join(outDir, REPORT_FILES.json as string), 'utf8')).toBe(jsonReport(fixture()));
    expect(JSON.parse(readFileSync(join(outDir, 'mutation.json'), 'utf8')).schemaVersion).toBe('2');
  });

  it('runs a reporter named twice once', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'tzap-report-'));
    expect(writeReports(fixture(), ['agent', 'agent'], { outDir, color: false })).toBe(agentReport(fixture()));
  });

  it('refuses an unknown name before writing anything, and lists the valid ones', () => {
    const outDir = join(mkdtempSync(join(tmpdir(), 'tzap-report-')), 'out');
    expect(() => writeReports(fixture(), ['json', 'xml', 'toString'], { outDir, color: false })).toThrow(
      `unknown reporter "xml", "toString"; valid reporters are ${Object.keys(reporters).join(', ')}`,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it('has a file name for every reporter that produces a file', () => {
    const ctx = { outDir: '', color: false };
    for (const [name, reporter] of Object.entries(reporters)) {
      if (reporter(fixture(), ctx).file !== undefined) expect(REPORT_FILES[name], name).toBeDefined();
    }
  });
});
