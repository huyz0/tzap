import fs from 'node:fs';
import { parseSync as oxcParse } from 'oxc-parser';
import * as babelParser from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import swc from '@swc/core';
import ts from 'typescript6';
import MagicString from 'magic-string';
const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;

const files = process.argv.slice(2);
const OPS = { '+': '-', '-': '+', '*': '/', '/': '*', '<': '<=', '<=': '<', '>': '>=', '>=': '>', '===': '!==', '!==': '===', '&&': '||', '||': '&&' };

function time(label, fn, iters) {
  fn(); fn(); // warm
  const t = [];
  for (let i = 0; i < iters; i++) { const s = process.hrtime.bigint(); fn(); t.push(Number(process.hrtime.bigint() - s) / 1e6); }
  t.sort((a, b) => a - b);
  return { label, median: t[Math.floor(t.length / 2)].toFixed(1), min: t[0].toFixed(1) };
}

function walk(node, cb) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, cb); return; }
  if (typeof node.type === 'string') cb(node);
  for (const k in node) { if (k === 'parent') continue; const v = node[k]; if (v && typeof v === 'object') walk(v, cb); }
}

function oxcInstrument(file, src, raw) {
  const r = oxcParse(file, src, raw ? { experimentalRawTransfer: true } : {});
  const ms = new MagicString(src);
  let id = 0;
  walk(r.program, (n) => {
    if ((n.type === 'BinaryExpression' || n.type === 'LogicalExpression') && OPS[n.operator]) {
      const l = src.slice(n.left.start, n.left.end), rr = src.slice(n.right.start, n.right.end);
      ms.prependLeft(n.start, `(__tzm===${id++}?(${l} ${OPS[n.operator]} ${rr}):`);
      ms.appendRight(n.end, ')');
    }
  });
  const code = ms.toString();
  const map = ms.generateMap({ hires: 'boundary', source: file });
  return { id, len: code.length, map };
}

function babelInstrument(file, src) {
  const ast = babelParser.parse(src, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators'], errorRecovery: true });
  let id = 0;
  const t = babelTypes;
  traverse(ast, { noScope: true,
    'BinaryExpression|LogicalExpression': { enter(p) { if (!p.node.__tz && OPS[p.node.operator]) p.node.__orig = t.cloneNode(p.node, true); }, exit(p) {
      const n = p.node;
      if (n.__tz || !OPS[n.operator] || n.left.type === 'PrivateName') return;
      const mut = n.__orig; mut.operator = OPS[n.operator]; mut.__tz = true; n.__tz = true;
      p.replaceWith(t.conditionalExpression(t.binaryExpression('===', t.identifier('__tzm'), t.numericLiteral(id++)), mut, n));
      p.skip();
    } },
  });
  const out = generate(ast, { sourceMaps: true, sourceFileName: file }, src);
  return { id, len: out.code.length };
}
import * as babelTypes from '@babel/types';

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const iters = src.length > 3e6 ? 5 : 15;
  const tsx = f.endsWith('x');
  const res = [];
  if (process.env.PARSE_ONLY) { for (const [l,fn] of [['oxc',()=>oxcParse(f,src)],['oxc raw',()=>oxcParse(f,src,{experimentalRawTransfer:true})],['babel',()=>babelParser.parse(src,{sourceType:'module',plugins:['typescript','jsx'],errorRecovery:true})],['swc',()=>swc.parseSync(src,{syntax:'typescript',tsx})],['ts6',()=>ts.createSourceFile(f,src,ts.ScriptTarget.Latest)]]) res.push(time(l,fn,iters)); console.table(res); continue; }
  res.push(time('oxc-parser parseSync (JS AST)', () => oxcParse(f, src), iters));
  res.push(time('oxc-parser parseSync rawTransfer', () => oxcParse(f, src, { experimentalRawTransfer: true }), iters));
  res.push(time('@babel/parser 7 (ts,jsx)', () => babelParser.parse(src, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true }), iters));
  res.push(time('@swc/core parseSync', () => swc.parseSync(src, { syntax: 'typescript', tsx }), iters));
  res.push(time('typescript 6 createSourceFile', () => ts.createSourceFile(f, src, ts.ScriptTarget.Latest, false, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS), iters));
  const oi = oxcInstrument(f, src, false);
  res.push(time(`oxc + walk + magic-string + map (${oi.id} mutants)`, () => oxcInstrument(f, src, false), iters));
  res.push(time(`oxc raw + walk + magic-string + map`, () => oxcInstrument(f, src, true), iters));
  const bi = babelInstrument(f, src);
  res.push(time(`babel parse+traverse+generate+map (${bi.id} mutants)`, () => babelInstrument(f, src), Math.max(3, iters / 3 | 0)));
  console.log(`\n## ${f} (${(src.length / 1024).toFixed(0)} KiB, ${src.split('\n').length} lines)`);
  console.table(res);
}
