/**
 * Every tzap output format, each a pure function from an `AnalysisResult` to text. Output is
 * byte-identical for the same result, whatever order its mutants arrive in, apart from the
 * timing and duration fields; only `writeReports` touches the file system.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisResult } from '@tzap/model';
import { agentReport } from './agent.js';
import { consoleReport } from './console.js';
import { elementsJson } from './elements.js';
import { githubReport } from './github.js';
import { htmlReport } from './html.js';
import { jsonReport } from './json.js';
import { markdownReport } from './markdown.js';
import { sarifJson } from './sarif.js';
import type { ReportContext } from './util.js';

export { agentReport } from './agent.js';
export { consoleReport } from './console.js';
export { ELEMENTS_SCHEMA_VERSION, elementsJson, elementsReport } from './elements.js';
export { GITHUB_ANNOTATION_LIMIT, githubReport } from './github.js';
export { elementsBundle, htmlReport } from './html.js';
export { REPORT_SCHEMA_VERSION, canonicalResult, jsonReport } from './json.js';
export { MARKDOWN_ROW_LIMIT, markdownReport } from './markdown.js';
export { sarifJson, sarifReport } from './sarif.js';
export type { ReportContext } from './util.js';

/** A reporter's output: file content for `outDir`, text for stdout, or both. */
export interface ReportOutput {
  file?: string;
  stdout?: string;
}

export type Reporter = (result: AnalysisResult, ctx: ReportContext) => ReportOutput;

export const reporters: Record<string, Reporter> = {
  console: (r, ctx) => ({ stdout: consoleReport(r, ctx) }),
  json: (r) => ({ file: jsonReport(r) }),
  elements: (r) => ({ file: elementsJson(r) }),
  html: (r) => ({ file: htmlReport(r) }),
  agent: (r) => ({ stdout: agentReport(r) }),
  github: (r, ctx) => ({ stdout: githubReport(r, ctx) }),
  sarif: (r, ctx) => ({ file: sarifJson(r, ctx) }),
  markdown: (r, ctx) => ({ file: markdownReport(r, ctx) }),
};

/** Where each file-writing reporter puts its output, relative to `outDir`. */
export const REPORT_FILES: Record<string, string> = {
  json: 'tzap.json',
  elements: 'mutation.json',
  html: 'mutation.html',
  sarif: 'tzap.sarif',
  markdown: 'tzap.md',
};

/**
 * Runs the named reporters in the order given, writes their files to `ctx.outDir`, and returns
 * what they print. Every name is checked before anything runs, so a typo writes nothing.
 */
export function writeReports(result: AnalysisResult, names: readonly string[], ctx: ReportContext): string {
  const unknown = names.filter((n) => !Object.hasOwn(reporters, n));
  if (unknown.length > 0) {
    throw new Error(`unknown reporter ${unknown.map((n) => `"${n}"`).join(', ')}; valid reporters are ${Object.keys(reporters).join(', ')}`);
  }
  let stdout = '';
  for (const name of new Set(names)) {
    const out = (reporters[name] as Reporter)(result, ctx);
    if (out.file !== undefined) {
      mkdirSync(ctx.outDir, { recursive: true });
      writeFileSync(join(ctx.outDir, REPORT_FILES[name] ?? `${name}.txt`), out.file, 'utf8');
    }
    if (out.stdout !== undefined) stdout += out.stdout;
  }
  return stdout;
}
