#!/usr/bin/env node
// Compares tzap and StrykerJS over corpus projects that run.mjs has produced results for.
//
//   node compare.mjs [project ...] [--engine warm|reference] [--baseline FILE] [--no-gate]
//
// Per project: the inventory diff (tzap-only / stryker-only / shared, grouped by mutator and by
// cause), the verdict agreement matrix over the mutation-testing-elements statuses, the
// killedBy/coveredBy comparison, and the flaky bucket (mutants whose verdict flipped between
// a tool's two runs; quarantined, never compared). Writes reports/<project>.md.
//
// Gate (parity-baseline.yaml): every difference must be matched by a baseline entry (by kind,
// project glob and key glob, optionally by the two statuses), and every baseline entry whose
// project glob covers a compared project must still match something. Exit 1 otherwise.
//
// Difference kinds, each keyed `<file>|<mutator>|<start>-<end>|<replacement>`:
//   tzap-only, stryker-only   inventory
//   verdict                   shared mutant, different status
//   coveredBy                 shared mutant, different covering-test sets (both tools reported one)
//   killedBy                  both Killed, and a tool's killing test is not among the tests the
//                             other tool says cover the mutant (a plain "different first killer"
//                             among shared covering tests is expected: both stop at the first
//                             failure and order tests differently, so it is only counted)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HERE, REPORTS, RESULTS, fnmatch, loadLock, median, readYaml } from './lib.mjs';
import { STATUSES, loadMapping, readReport } from './normalise.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const engine = opt('engine', 'warm');
const baselineFile = opt('baseline', path.join(HERE, 'parity-baseline.yaml'));
const gate = !argv.includes('--no-gate');
const named = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const lock = loadLock();
const projects = named.length ? named : lock.projects.map((p) => p.name).filter((n) => existsSync(path.join(RESULTS, n, 'runs.json')));
const mapping = loadMapping();

const KINDS = ['tzap-only', 'stryker-only', 'verdict', 'coveredBy', 'killedBy'];

function loadBaseline() {
  if (!existsSync(baselineFile)) return [];
  const doc = readYaml(baselineFile) ?? {};
  // `accepted`: B/C/D, pass the gate. `open_tzap_bugs`: class A, open. They classify the
  // difference in the report (so triage is complete) but still fail the gate until fixed.
  const open = (doc.open_tzap_bugs ?? []).map((e) => ({ ...e, classification: 'A' }));
  return [...(doc.accepted ?? []), ...open].map((e, i) => {
    if (!KINDS.includes(e.kind)) throw new Error(`${baselineFile}: entry ${i + 1} (${e.id ?? '?'}): kind must be one of ${KINDS.join(', ')}`);
    if (!['B', 'C', 'D'].includes(e.classification) && !open.includes(e)) {
      throw new Error(`${baselineFile}: entry ${e.id ?? i + 1}: classification must be B, C or D under accepted (class A goes under open_tzap_bugs)`);
    }
    if (!e.note) throw new Error(`${baselineFile}: entry ${e.id ?? i + 1}: a justification (note) is required`);
    return { ...e, id: e.id ?? `#${i + 1}`, project: e.project ?? '*', matched: 0 };
  });
}
const baseline = loadBaseline();
/** `project` is a glob or a list of globs. */
const projectMatches = (project, e) => [e.project].flat().some((g) => fnmatch(project, g));

function classify(project, diff) {
  for (const e of baseline) {
    if (e.kind !== diff.kind) continue;
    if (!projectMatches(project, e)) continue;
    if (!fnmatch(diff.key, e.key)) continue;
    if (e.stryker && diff.stryker !== e.stryker) continue;
    if (e.tzap && diff.tzap !== e.tzap) continue;
    e.matched++;
    return e;
  }
  return undefined;
}

const byMutator = (a, b) => (a.file + a.mutator + a.start.line).localeCompare(b.file + b.mutator + b.start.line) || a.start.line - b.start.line || a.start.column - b.start.column;
const posStr = (p) => `${p.line}:${p.column}`;
const span = (r) => `${posStr(r.start)}-${posStr(r.end)}`;
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (s, n = 60) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');

/** Why an inventory-only mutant has no partner, from the other tool's leftovers. */
function causeOf(r, others) {
  const sameFile = others.filter((o) => o.file === r.file);
  if (sameFile.some((o) => o.mutator === r.mutator && span(o) === span(r))) return 'same site, different replacement text';
  if (sameFile.some((o) => o.mutator === r.mutator && o.replacement === r.replacement && (posStr(o.start) === posStr(r.start) || posStr(o.end) === posStr(r.end)))) {
    return 'same replacement, different span';
  }
  if (sameFile.some((o) => o.mutator === r.mutator && o.start.line <= r.end.line && r.start.line <= o.end.line && (posStr(o.start) === posStr(r.start) || posStr(o.end) === posStr(r.end)))) {
    return 'overlapping span, different replacement';
  }
  if (sameFile.some((o) => o.mutator !== r.mutator && span(o) === span(r) && o.replacement === r.replacement)) return 'same mutation, different mutator name';
  return 'no counterpart';
}

function loadRuns(project) {
  const dir = path.join(RESULTS, project);
  const meta = JSON.parse(readFileSync(path.join(dir, 'runs.json'), 'utf8'));
  const projectDir = path.join(HERE, 'corpus', project);
  const read = (sub) => {
    const f = path.join(dir, sub, 'mutation.json');
    return existsSync(f) ? readReport(f, { projectDir, mapping }) : undefined;
  };
  return {
    meta,
    stryker: [read('stryker-1'), read('stryker-2')].filter(Boolean),
    tzap: [read(`tzap-${engine}-1`), read(`tzap-${engine}-2`)].filter(Boolean),
  };
}

/** Keys whose verdict (or presence) differs between a tool's runs. */
function flakyKeys(runs) {
  const out = new Map();
  if (runs.length < 2) return out;
  const [a, b] = runs;
  for (const [k, r] of a.records) {
    const o = b.records.get(k);
    if (!o) out.set(k, `run 1 ${r.status}, run 2 absent`);
    else if (o.status !== r.status) out.set(k, `run 1 ${r.status}, run 2 ${o.status}`);
  }
  for (const [k, o] of b.records) if (!a.records.has(k)) out.set(k, `run 1 absent, run 2 ${o.status}`);
  return out;
}

function compareProject(project) {
  const { meta, stryker, tzap } = loadRuns(project);
  if (!stryker.length || !tzap.length) throw new Error(`${project}: missing reports (stryker ${stryker.length}, tzap-${engine} ${tzap.length}); run: node run.mjs ${project}`);
  const S = stryker[0].records;
  const T = tzap[0].records;
  const flakyS = flakyKeys(stryker);
  const flakyT = flakyKeys(tzap);

  const shared = [...S.keys()].filter((k) => T.has(k));
  const strykerOnly = [...S.keys()].filter((k) => !T.has(k)).map((k) => S.get(k));
  const tzapOnly = [...T.keys()].filter((k) => !S.has(k)).map((k) => T.get(k));

  const diffs = [];
  for (const r of tzapOnly) diffs.push({ kind: 'tzap-only', key: r.key, rec: r, cause: causeOf(r, strykerOnly), tzap: r.status });
  for (const r of strykerOnly) diffs.push({ kind: 'stryker-only', key: r.key, rec: r, cause: causeOf(r, tzapOnly), stryker: r.status });

  const matrix = new Map();
  const flaky = [];
  let compared = 0;
  let agreed = 0;
  const killer = { bothKilled: 0, sameKiller: 0, killerCoveredByOther: 0 };
  const coverage = { bothReported: 0, equal: 0 };
  for (const k of shared) {
    const s = S.get(k);
    const t = T.get(k);
    if (flakyS.has(k) || flakyT.has(k)) {
      flaky.push({ key: k, stryker: flakyS.get(k) ?? `stable ${s.status}`, tzap: flakyT.get(k) ?? `stable ${t.status}` });
      continue;
    }
    compared++;
    const cell = `${s.status}|${t.status}`;
    matrix.set(cell, (matrix.get(cell) ?? 0) + 1);
    if (s.status === t.status) agreed++;
    else diffs.push({ kind: 'verdict', key: k, rec: t, other: s, stryker: s.status, tzap: t.status });

    if (s.coveredBy && t.coveredBy && !s.static && !t.static) {
      coverage.bothReported++;
      const sSet = new Set(s.coveredBy);
      const tSet = new Set(t.coveredBy);
      const onlyS = s.coveredBy.filter((x) => !tSet.has(x));
      const onlyT = t.coveredBy.filter((x) => !sSet.has(x));
      if (!onlyS.length && !onlyT.length) coverage.equal++;
      else diffs.push({ kind: 'coveredBy', key: k, rec: t, other: s, onlyS, onlyT, stryker: s.status, tzap: t.status });
    }
    if (s.status === 'Killed' && t.status === 'Killed') {
      killer.bothKilled++;
      const sk = s.killedBy ?? [];
      const tk = t.killedBy ?? [];
      if (sk.join() === tk.join()) killer.sameKiller++;
      const tInS = tk.every((x) => (s.coveredBy ?? []).includes(x)) || s.static;
      const sInT = sk.every((x) => (t.coveredBy ?? []).includes(x)) || t.static;
      if (tInS && sInT) killer.killerCoveredByOther++;
      else diffs.push({ kind: 'killedBy', key: k, rec: t, other: s, sk, tk, stryker: s.status, tzap: t.status });
    }
  }
  // Inventory-only mutants that flipped are still inventory differences, but say so.
  for (const d of diffs) {
    const fl = d.kind === 'tzap-only' ? flakyT.get(d.key) : d.kind === 'stryker-only' ? flakyS.get(d.key) : undefined;
    if (fl) d.flaky = fl;
  }
  for (const d of diffs) d.entry = classify(project, d);

  // Hand-written expectations (Tier A fixtures): outrank both tools.
  const expectations = [];
  const expFile = path.join(HERE, 'corpus', project, 'parity-expectations.yaml');
  if (existsSync(expFile)) {
    for (const e of readYaml(expFile)?.expectations ?? []) {
      const verdict = (records) => {
        const hits = [...records.values()].filter((r) => fnmatch(r.key, e.key));
        if (e.status === 'absent') return { ok: hits.length === 0, got: hits.length ? hits.map((r) => r.status).join(',') : 'absent' };
        if (!hits.length) return { ok: false, got: 'absent' };
        return { ok: hits.every((r) => [e.status].flat().includes(r.status)), got: hits.map((r) => r.status).join(',') };
      };
      expectations.push({ ...e, stryker: verdict(S), tzap: verdict(T) });
    }
  }

  const timing = (tool) => {
    const ms = meta.runs.filter((r) => r.tool === tool).map((r) => r.ms);
    return { median: median(ms), all: ms };
  };
  return {
    project,
    meta,
    counts: { stryker: S.size, tzap: T.size, shared: shared.length, strykerOnly: strykerOnly.length, tzapOnly: tzapOnly.length },
    compared,
    agreed,
    matrix,
    flaky,
    flakyS,
    flakyT,
    diffs,
    expectations,
    killer,
    coverage,
    checks: {
      stryker: { loc: stryker[0].locationCheck, dup: stryker[0].duplicates, unmapped: stryker[0].unmapped },
      tzap: { loc: tzap[0].locationCheck, dup: tzap[0].duplicates, unmapped: tzap[0].unmapped },
    },
    timing: { stryker: timing('stryker'), tzap: timing(`tzap-${engine}`) },
    statusCounts: {
      stryker: countStatus(S),
      tzap: countStatus(T),
    },
  };
}

function countStatus(records) {
  const c = {};
  for (const r of records.values()) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}

function renderReport(res) {
  const L = [];
  const { meta, counts } = res;
  const lockEntry = lock.projects.find((p) => p.name === res.project) ?? {};
  const pct = res.compared ? ((100 * res.agreed) / res.compared).toFixed(1) : '100.0';
  const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : 'n/a');
  L.push(`# Parity report: ${res.project}`, '');
  L.push(`Generated by \`tools/parity/compare.mjs\` — do not edit by hand. Tier ${lockEntry.tier ?? '?'}` + (meta.commit ? `, commit \`${meta.commit}\`` : '') + '.', '');
  L.push(`StrykerJS ${meta.stryker} (vitest-runner, perTest, ignoreStatic false, checkers none) vs tzap (engine \`${engine}\`, \`--no-arid\`), Vitest ${meta.vitest}, Node ${meta.node}, concurrency/workers ${meta.concurrency}, Stryker timeoutMS ${meta.timeoutMS}.`, '');
  L.push('## Summary', '');
  L.push('| | StrykerJS | tzap |', '|---|---:|---:|');
  L.push(`| mutants | ${counts.stryker} | ${counts.tzap} |`);
  L.push(`| only in this tool | ${counts.strykerOnly} | ${counts.tzapOnly} |`);
  L.push(`| flaky (verdict flipped between the tool's two runs) | ${res.flakyS.size} | ${res.flakyT.size} |`);
  L.push(`| wall clock, median of ${res.timing.stryker.all.length} / ${res.timing.tzap.all.length} runs | ${secs(res.timing.stryker.median)} (${res.timing.stryker.all.map(secs).join(', ')}) | ${secs(res.timing.tzap.median)} (${res.timing.tzap.all.map(secs).join(', ')}) |`);
  for (const s of STATUSES) {
    const a = res.statusCounts.stryker[s] ?? 0;
    const b = res.statusCounts.tzap[s] ?? 0;
    if (a || b) L.push(`| ${s} | ${a} | ${b} |`);
  }
  L.push('');
  L.push(`**Shared mutants: ${counts.shared}; compared (non-flaky): ${res.compared}; verdict agreement: ${res.agreed}/${res.compared} (${pct}%).**`, '');
  const locMsg = (c) => `${c.loc.checked} bracketed mutants checked, ${c.loc.failed.length} off` + (c.dup.length ? `; ${c.dup.length} duplicate keys` : '') + (Object.keys(c.unmapped).length ? `; unmapped mutators ${JSON.stringify(c.unmapped)}` : '');
  L.push(`Location convention (1-based line, 1-based end-exclusive column) verified on source text: Stryker ${locMsg(res.checks.stryker)}; tzap ${locMsg(res.checks.tzap)}.`, '');

  L.push('## Verdict agreement matrix', '', 'Rows StrykerJS, columns tzap; shared, non-flaky mutants.', '');
  const used = STATUSES.filter((s) => [...res.matrix.keys()].some((k) => k.split('|').includes(s)));
  L.push(`| Stryker \\ tzap | ${used.join(' | ')} |`, `|---|${used.map(() => '---:').join('|')}|`);
  for (const r of used) L.push(`| **${r}** | ${used.map((c) => (res.matrix.get(`${r}|${c}`) ? (r === c ? `**${res.matrix.get(`${r}|${c}`)}**` : res.matrix.get(`${r}|${c}`)) : '·')).join(' | ')} |`);
  L.push('');

  const cls = (d) => (d.entry ? `${d.entry.classification} (${d.entry.id})` : '**UNCLASSIFIED**');
  const inv = res.diffs.filter((d) => d.kind === 'tzap-only' || d.kind === 'stryker-only');
  L.push('## Inventory differences', '');
  if (!inv.length) L.push('None: both tools generated exactly the same mutants.', '');
  else {
    const groups = new Map();
    for (const d of inv) {
      const g = `${d.kind}|${d.rec.mutator}|${d.cause}|${d.entry ? `${d.entry.classification} (${d.entry.id})` : 'UNCLASSIFIED'}`;
      groups.set(g, (groups.get(g) ?? 0) + 1);
    }
    L.push('| side | mutator | cause | count | classification |', '|---|---|---|---:|---|');
    for (const [g, n] of [...groups].sort()) {
      const [side, mut, cause, c] = g.split('|');
      L.push(`| ${side} | ${mut} | ${cause} | ${n} | ${c === 'UNCLASSIFIED' ? '**UNCLASSIFIED**' : c} |`);
    }
    L.push('', '<details><summary>Every inventory difference</summary>', '');
    L.push('| side | file | mutator | span | original | replacement | status | classification |', '|---|---|---|---|---|---|---|---|');
    for (const d of inv.sort((a, b) => byMutator(a.rec, b.rec))) {
      L.push(`| ${d.kind} | ${d.rec.file} | ${d.rec.mutator} | ${span(d.rec)} | \`${md(short(d.rec.original))}\` | \`${md(short(d.rec.rawReplacement))}\` | ${d.rec.status}${d.flaky ? ` (flaky: ${d.flaky})` : ''} | ${cls(d)} |`);
    }
    L.push('', '</details>', '');
  }

  const verd = res.diffs.filter((d) => d.kind === 'verdict');
  L.push('## Verdict disagreements', '');
  if (!verd.length) L.push('None.', '');
  else {
    L.push('| file | mutator | span | original → replacement | Stryker | tzap | classification |', '|---|---|---|---|---|---|---|');
    for (const d of verd.sort((a, b) => byMutator(a.rec, b.rec))) {
      L.push(`| ${d.rec.file} | ${d.rec.mutator} | ${span(d.rec)} | \`${md(short(d.rec.original, 40))}\` → \`${md(short(d.rec.rawReplacement, 40))}\` | ${d.stryker}${d.other.static ? ' (static)' : ''} | ${d.tzap}${d.rec.static ? ' (static)' : ''} | ${cls(d)} |`);
    }
    L.push('');
    L.push('<details><summary>Status reasons</summary>', '');
    for (const d of verd) L.push(`- \`${md(d.key)}\`: Stryker: ${md(short(d.other.statusReason, 160)) || '—'}; tzap: ${md(short(d.rec.statusReason, 160)) || '—'}`);
    L.push('', '</details>', '');
  }

  L.push('## Killing tests and coverage', '');
  L.push(`- Both Killed: ${res.killer.bothKilled}; same killing test(s): ${res.killer.sameKiller}; each tool's killer within the other's covering set: ${res.killer.killerCoveredByOther}.`);
  L.push(`- Covering sets compared (both tools reported coveredBy, neither static): ${res.coverage.bothReported}; identical: ${res.coverage.equal}.`, '');
  const cov = res.diffs.filter((d) => d.kind === 'coveredBy' || d.kind === 'killedBy');
  if (cov.length) {
    L.push('| kind | mutant | Stryker | tzap | detail | classification |', '|---|---|---|---|---|---|');
    for (const d of cov.sort((a, b) => byMutator(a.rec, b.rec))) {
      const detail =
        d.kind === 'coveredBy'
          ? `only Stryker: ${d.onlyS.length} (${md(short(d.onlyS.join('; '), 120))}); only tzap: ${d.onlyT.length} (${md(short(d.onlyT.join('; '), 120))})`
          : `Stryker killedBy ${md(short(d.sk.join('; '), 100))}; tzap killedBy ${md(short(d.tk.join('; '), 100))}`;
      L.push(`| ${d.kind} | \`${md(short(d.key, 90))}\` | ${d.stryker} | ${d.tzap} | ${detail} | ${cls(d)} |`);
    }
    L.push('');
  }

  L.push('## Flaky bucket (quarantined)', '');
  if (!res.flaky.length && !res.flakyS.size && !res.flakyT.size) L.push('None: every mutant had the same verdict in both runs of each tool.', '');
  else {
    L.push('Excluded from the verdict comparison. A flaky mutant is a test-quality signal about the project (class D) or a runner-reuse/timeout artefact.', '');
    L.push('| mutant | StrykerJS | tzap |', '|---|---|---|');
    const keys = new Set([...res.flakyS.keys(), ...res.flakyT.keys()]);
    for (const k of [...keys].sort()) L.push(`| \`${md(short(k, 100))}\` | ${res.flakyS.get(k) ?? 'stable'} | ${res.flakyT.get(k) ?? 'stable'} |`);
    L.push('');
  }

  if (res.expectations.length) {
    L.push('## Hand-written expectations', '', "From the fixture's parity-expectations.yaml; these outrank both tools. A tzap miss fails the gate.", '');
    L.push('| key | expected | StrykerJS | tzap | note |', '|---|---|---|---|---|');
    const cell = (v) => `${v.ok ? 'ok' : '**MISS**'} (${v.got})`;
    for (const e of res.expectations) L.push(`| \`${md(e.key)}\` | ${[e.status].flat().join(' or ')} | ${cell(e.stryker)} | ${cell(e.tzap)} | ${md(e.note)} |`);
    L.push('');
  }
  const unl = res.diffs.filter((d) => !d.entry);
  const openA = res.diffs.filter((d) => d.entry?.classification === 'A');
  L.push('## Gate', '');
  if (openA.length) L.push(`**${openA.length} difference(s) are open class-A tzap bugs** (${[...new Set(openA.map((d) => d.entry.id))].join(', ')}): the gate stays red until they are fixed.`, '');
  L.push(unl.length ? `**${unl.length} difference(s) not accounted for in parity-baseline.yaml.** Triage each as A (tzap bug: fix, never baseline), B, C or D.` : 'Every difference is accounted for in parity-baseline.yaml.', '');
  const used2 = baseline.filter((e) => projectMatches(res.project, e));
  if (used2.length) {
    L.push('| baseline entry | kind | class | matched here | note |', '|---|---|---|---:|---|');
    const perEntry = new Map();
    for (const d of res.diffs) if (d.entry) perEntry.set(d.entry.id, (perEntry.get(d.entry.id) ?? 0) + 1);
    for (const e of used2) L.push(`| ${e.id} | ${e.kind} | ${e.classification} | ${perEntry.get(e.id) ?? 0} | ${md(short(e.note.trim(), 220))} |`);
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

let failed = false;
const results = [];
for (const project of projects) {
  let res;
  try {
    res = compareProject(project);
  } catch (e) {
    console.error(e.message);
    failed = true;
    continue;
  }
  results.push(res);
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(path.join(REPORTS, `${project}${engine === 'warm' ? '' : `.${engine}`}.md`), renderReport(res));
}

console.log('project           shared  agree        S-only T-only flakyS flakyT  unlisted  stryker(s) tzap(s)');
for (const r of results) {
  const unl = r.diffs.filter((d) => !d.entry).length;
  const pct = r.compared ? ((100 * r.agreed) / r.compared).toFixed(1) : '100.0';
  console.log(
    `${r.project.padEnd(17)} ${String(r.counts.shared).padStart(6)}  ${`${r.agreed}/${r.compared} ${pct}%`.padEnd(12)} ${String(r.counts.strykerOnly).padStart(6)} ${String(r.counts.tzapOnly).padStart(6)} ${String(r.flakyS.size).padStart(6)} ${String(r.flakyT.size).padStart(6)}  ${String(unl).padStart(8)}  ${(r.timing.stryker.median / 1000).toFixed(1).padStart(9)} ${(r.timing.tzap.median / 1000).toFixed(1).padStart(7)}`,
  );
  const missed = r.expectations.filter((e) => !e.tzap.ok);
  if (missed.length) {
    failed = true;
    console.log(`  tzap misses ${missed.length} hand-written expectation(s): ${missed.map((e) => e.key).join('; ')}`);
  }
  const openA = r.diffs.filter((d) => d.entry?.classification === 'A');
  if (openA.length) {
    failed = true;
    console.log(`  open class-A tzap bugs: ${openA.length} difference(s) (${[...new Set(openA.map((d) => d.entry.id))].join(', ')})`);
  }
  if (unl) {
    failed = true;
    const byKind = {};
    for (const d of r.diffs.filter((x) => !x.entry)) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    console.log(`  unlisted: ${JSON.stringify(byKind)} (see reports/${r.project}.md)`);
  }
}
const compared = new Set(results.map((r) => r.project));
// An entry is checked for staleness only when every corpus project it covers was compared in
// this invocation (and has results): a global entry is judged on a full-corpus run, a
// project-specific one whenever that project is compared.
const covers = (e) => lock.projects.map((p) => p.name).filter((n) => projectMatches(n, e) && existsSync(path.join(RESULTS, n, 'runs.json')));
const stale = baseline.filter((e) => {
  const c = covers(e);
  return c.length > 0 && c.every((n) => compared.has(n)) && e.matched === 0;
});
const deferred = baseline.filter((e) => e.matched === 0 && !stale.includes(e) && covers(e).some((n) => compared.has(n)));
if (deferred.length) console.log(`\n(${deferred.length} baseline entr${deferred.length === 1 ? 'y' : 'ies'} unmatched here also cover projects not compared in this run; staleness is judged on a run that includes them: ${deferred.map((e) => e.id).join(', ')})`);
if (stale.length) {
  failed = true;
  console.log('\nStale baseline entries (no longer match any difference; behaviour moved, re-triage and update the baseline):');
  for (const e of stale) console.log(`  ${e.id} [${e.kind}] project=${[e.project].flat().join(',')} key=${e.key}`);
}
if (gate) {
  console.log(failed ? '\nFAIL' : '\nPASS: every difference is accounted for in the baseline, and every baseline entry still occurs.');
  process.exitCode = failed ? 1 : 0;
}
