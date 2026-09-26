#!/usr/bin/env node
// One mutation-testing-elements reader for both tools' reports, producing one record type.
//
//   node normalise.mjs <mutation.json> [--project-dir DIR] [--tool stryker|tzap]   (prints JSON)
//
// Record key (Stryker's own incremental key, docs/parity-and-benchmarks.md §3):
//
//     <package-relative file>|<mutatorName>|<startLine>:<startCol>-<endLine>:<endCol>|<replacement>
//
// - file: relative to the package directory, forward slashes. tzap writes paths relative to the
//   model root and Stryker relative to its cwd; both are resolved against the report's
//   `projectRoot` and made relative to the project directory.
// - mutatorName: tzap names mapped through mutator-mapping.yaml onto Stryker's.
// - location: as written. Both tools write 1-based lines and 1-based, end-exclusive columns in
//   the elements report (Stryker converts Babel's 0-based columns with +1 on both ends in
//   core's report helper; tzap writes 1-based). `checkLocations()` verifies this on every read
//   by slicing the file's `source` with that convention and checking bracketed mutants
//   (BlockStatement, ObjectLiteral, ArrayDeclaration `[]`) start and end on their brackets.
// - replacement: first reprinted with @babel/generator (what Stryker itself prints with), which
//   drops redundant parentheses tzap copies from the source (`(p * q) / 100` -> `p * q / 100`)
//   and comments (Stryker prints the leading comments attached to the mutated node);
//   then all whitespace removed and every quote character (' " `) mapped to ", so `''` and
//   `""` compare equal. A replacement that does not parse as an expression is used as written.
//
// Tests are identified across tools by `<test file>::<full name>`, with Vitest's suite
// separator normalised: tzap joins suite and test names with " > ", Stryker with " ".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import generateModule from '@babel/generator';
import { parseExpression } from '@babel/parser';
import { HERE, readYaml, slash } from './lib.mjs';

const generate = generateModule.default ?? generateModule;

export const STATUSES = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'RuntimeError', 'CompileError', 'Ignored', 'Pending'];

export function loadMapping(file = path.join(HERE, 'mutator-mapping.yaml')) {
  const doc = readYaml(file);
  const tzapToStryker = new Map();
  const relation = new Map();
  for (const m of doc.mappings ?? []) {
    tzapToStryker.set(m.tzap, m.stryker?.[0] ?? null);
    relation.set(m.tzap, m.relation);
  }
  const strykerKnown = new Set((doc.mappings ?? []).flatMap((m) => m.stryker ?? []));
  const unmappedStryker = new Set(doc.unmapped_stryker ?? []);
  return { tzapToStryker, relation, strykerKnown, unmappedStryker };
}

const reprintCache = new Map();
/**
 * Reprints an expression the way Stryker prints every replacement (@babel/generator 8 defaults,
 * the same version Stryker 10 uses), so redundant parentheses and formatting a tool copied from
 * the source (tzap keeps source text, e.g. `(a * b) / c`) do not make one mutation look like
 * two. Replacements that are not expressions (`;`, statements) are left as written.
 */
function reprint(r) {
  if (reprintCache.has(r)) return reprintCache.get(r);
  let out = r;
  try {
    out = generate(parseExpression(r, { plugins: ['typescript', 'jsx'] }), { comments: false }).code;
  } catch {
    // not an expression
  }
  reprintCache.set(r, out);
  return out;
}

export const normaliseReplacement = (r) => reprint(r ?? '').replace(/\s+/g, '').replace(/['"`]/g, '"');

export const normaliseTestName = (name) => name.replace(/ > /g, ' ').replace(/\s+/g, ' ').trim();

const pos = (p) => `${p.line}:${p.column}`;

export function renderKey(r) {
  return `${r.file}|${r.mutator}|${pos(r.start)}-${pos(r.end)}|${r.replacement}`;
}

/** Offset of a 1-based line and 1-based column in `source`. */
function offsetOf(lineStarts, p) {
  return lineStarts[p.line - 1] + (p.column - 1);
}

function lineStartsOf(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

/**
 * Reads one report. `tool` is inferred from `framework.name` unless given.
 * Returns { tool, records: Map<key, record>, duplicates, unmapped, locationCheck, tests }.
 */
export function readReport(file, { projectDir, tool, mapping = loadMapping() } = {}) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  tool ??= /stryker/i.test(report.framework?.name ?? '') ? 'stryker' : 'tzap';
  const root = report.projectRoot ?? projectDir ?? path.dirname(file);
  const pkgDir = projectDir ?? root;
  const relFile = (f) => slash(path.relative(pkgDir, path.resolve(root, f)));

  // Test id -> normalised test identity.
  const tests = new Map();
  for (const [tf, { tests: list }] of Object.entries(report.testFiles ?? {})) {
    for (const t of list ?? []) tests.set(t.id, `${relFile(tf)}::${normaliseTestName(t.name)}`);
  }
  const testName = (id) => tests.get(id) ?? `?::${id}`;

  const records = new Map();
  const duplicates = [];
  const unmapped = {};
  const locationCheck = { checked: 0, failed: [] };
  for (const [f, entry] of Object.entries(report.files)) {
    const rel = relFile(f);
    const source = entry.source ?? '';
    const starts = lineStartsOf(source);
    for (const m of entry.mutants) {
      let mutator = m.mutatorName;
      if (tool === 'tzap') {
        const mapped = mapping.tzapToStryker.get(m.mutatorName);
        if (mapped === undefined) (unmapped[m.mutatorName] ??= 0), unmapped[m.mutatorName]++;
        if (mapped) mutator = mapped;
      } else if (!mapping.strykerKnown.has(m.mutatorName)) {
        (unmapped[m.mutatorName] ??= 0), unmapped[m.mutatorName]++;
      }
      const start = { line: m.location.start.line, column: m.location.start.column };
      const end = { line: m.location.end.line, column: m.location.end.column };
      const original = source ? source.slice(offsetOf(starts, start), offsetOf(starts, end)) : undefined;
      // Location convention self-check on bracketed mutants.
      const brackets = { BlockStatement: '{}', ObjectLiteral: '{}' }[mutator] ?? (mutator === 'ArrayDeclaration' && original?.startsWith('[') ? '[]' : undefined);
      if (brackets && original !== undefined) {
        locationCheck.checked++;
        if (original[0] !== brackets[0] || original[original.length - 1] !== brackets[1]) {
          locationCheck.failed.push(`${rel}:${pos(start)}-${pos(end)} ${mutator} original=${JSON.stringify(original.slice(0, 40))}`);
        }
      }
      const rec = {
        tool,
        id: m.id,
        file: rel,
        mutator,
        toolMutator: m.mutatorName,
        start,
        end,
        replacement: normaliseReplacement(m.replacement),
        rawReplacement: m.replacement,
        original,
        status: m.status,
        statusReason: m.statusReason,
        static: m.static ?? false,
        coveredBy: m.coveredBy ? [...new Set(m.coveredBy.map(testName))].sort() : undefined,
        killedBy: m.killedBy ? [...new Set(m.killedBy.map(testName))].sort() : undefined,
        testsCompleted: m.testsCompleted,
      };
      let key = renderKey(rec);
      if (records.has(key)) {
        duplicates.push(key);
        let n = 2;
        while (records.has(`${key}#${n}`)) n++;
        key = `${key}#${n}`;
      }
      rec.key = key;
      records.set(key, rec);
    }
  }
  return { tool, framework: report.framework, projectRoot: root, records, duplicates, unmapped, locationCheck, testCount: tests.size };
}

if (import.meta.url === `file:///${slash(process.argv[1] ?? '').replace(/^\//, '')}`) {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const file = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  if (!file) {
    console.error('usage: node normalise.mjs <mutation.json> [--project-dir DIR] [--tool stryker|tzap]');
    process.exit(2);
  }
  const r = readReport(file, { projectDir: opt('project-dir'), tool: opt('tool') });
  const { records, ...rest } = r;
  console.log(JSON.stringify({ ...rest, records: [...records.values()] }, null, 2));
}
