import { createHash } from 'node:crypto';
import MagicString from 'magic-string';
import type { MutantDescriptor } from '@tzap/model';
import { RUNTIME_GLOBAL, runtimeHeader } from '@tzap/runtime';
import { type Node, children, FUNCTION_TYPES, isIdentifier, isNode, isSkipped, LOOP_TYPES } from './ast.js';
import { Directives } from './directives.js';
import { ALL_MUTATORS, forTestOffset, type Mutator, type Placement } from './mutators.js';
import { parse } from './parse.js';
import { LineIndex } from './text.js';

export type LineRange = readonly [start: number, end: number];

/** Decides whether a mutant should be dropped before it runs. Returns the reason, or undefined to keep it. */
export type MutantFilter = (candidate: {
  mutatorName: string;
  node: Node;
  ancestors: readonly Node[];
  source: string;
}) => string | undefined;

export interface InstrumentInput {
  /** Path relative to the model root, forward slashes. Also used to pick the dialect. */
  file: string;
  source: string;
  /** Enabled mutator names. Default: all. */
  mutators?: readonly string[];
  /** Changed line ranges (inclusive). Undefined means the whole file is in scope. */
  lines?: readonly LineRange[];
  /** Named filters, applied in order; the first reason wins and the mutant is reported Ignored. */
  filters?: ReadonlyArray<{ name: string; filter: MutantFilter }>;
  /** First mutant number and first site number to allocate; numbers are unique across a run. */
  firstMutant: number;
  firstSite: number;
}

export interface InstrumentOutput {
  /** Instrumented source, in the original dialect. Undefined when nothing in the file needed instrumenting. */
  code: string | undefined;
  map: ReturnType<MagicString['generateMap']> | undefined;
  /** All mutants, placed and ignored, in source order. Ignored ones have `num === -1`. */
  mutants: MutantDescriptor[];
  nextMutant: number;
  nextSite: number;
  errors: string[];
}

interface Candidate {
  mutatorName: string;
  node: Node;
  replacement: string;
  placement: Placement;
  scope: string;
  ignoredBy?: string;
  statusReason?: string;
  removed?: boolean;
  /** Where the mutant is compiled in; set for placed mutants. */
  target?: Node;
  /** For `expression`/`arrow-body` placement: the text of `target` with this mutant applied. */
  targetText?: string;
  voidPrefix?: boolean;
}

const EXPRESSION_TYPES = new Set([
  'Identifier',
  'Literal',
  'TemplateLiteral',
  'ArrayExpression',
  'ObjectExpression',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassExpression',
  'UnaryExpression',
  'UpdateExpression',
  'BinaryExpression',
  'LogicalExpression',
  'AssignmentExpression',
  'ConditionalExpression',
  'CallExpression',
  'NewExpression',
  'MemberExpression',
  'ChainExpression',
  'SequenceExpression',
  'TaggedTemplateExpression',
  'AwaitExpression',
  'YieldExpression',
  'ImportExpression',
  'MetaProperty',
  'ThisExpression',
  'JSXElement',
  'JSXFragment',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

const STATEMENT_BOUNDARY = (n: Node) =>
  n.type === 'Program' ||
  n.type.endsWith('Statement') ||
  n.type.endsWith('Declaration') ||
  n.type === 'SwitchCase' ||
  n.type === 'ClassBody' ||
  n.type === 'StaticBlock' ||
  FUNCTION_TYPES.has(n.type) ||
  n.type === 'ClassExpression';

const PATTERN_TYPES = new Set(['ObjectPattern', 'ArrayPattern', 'RestElement']);

/** Whether `n`, whose parent is `parent`, can be replaced by a parenthesised conditional expression. */
function canWrap(n: Node, parent: Node | undefined): boolean {
  if (!EXPRESSION_TYPES.has(n.type)) return false;
  if (!parent) return false;
  switch (parent.type) {
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
      return parent.key !== n;
    case 'MemberExpression':
      return parent.object !== n && (parent.computed === true || parent.property !== n);
    case 'CallExpression':
      return parent.callee !== n;
    case 'NewExpression':
      return parent.callee !== n;
    case 'ChainExpression':
    case 'TaggedTemplateExpression':
    case 'JSXAttribute':
    case 'JSXElement':
    case 'JSXFragment':
    case 'JSXOpeningElement':
    case 'JSXClosingElement':
      return false;
    case 'UnaryExpression':
      return parent.operator !== 'delete';
    case 'AssignmentExpression':
      return parent.left !== n;
    case 'UpdateExpression':
      return false;
    case 'ForInStatement':
    case 'ForOfStatement':
      return parent.left !== n;
    case 'AssignmentPattern':
      return parent.left !== n;
    default:
      return !PATTERN_TYPES.has(parent.type);
  }
}

/** True when `node` sits inside the target of an assignment or update, where Stryker refuses to place. */
function inAssignmentTarget(node: Node, ancestors: readonly Node[]): boolean {
  let child = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]!;
    if (a.type === 'AssignmentExpression' && a.left === child) return true;
    if (a.type === 'UpdateExpression') return true;
    if ((a.type === 'ForInStatement' || a.type === 'ForOfStatement') && a.left === child) return true;
    if (STATEMENT_BOUNDARY(a)) return false;
    child = a;
  }
  return false;
}

function hash(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex').slice(0, 16);
}

function scopeName(node: Node, parent: Node | undefined, anonymous: number): string | undefined {
  const keyName = (k: unknown) => (isIdentifier(k) ? k.name : isNode(k) && typeof k.value === 'string' ? k.value : undefined);
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      return isIdentifier(node.id) ? node.id.name : `default`;
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassExpression': {
      if (isIdentifier(node.id)) return node.id.name;
      if (parent?.type === 'VariableDeclarator' && isIdentifier(parent.id)) return parent.id.name;
      if (parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition' || parent.type === 'MethodDefinition')) {
        const k = keyName(parent.key);
        if (k) return `${parent.type === 'MethodDefinition' ? `${parent.kind as string}:` : ''}${k}`;
      }
      return `<anonymous#${anonymous}>`;
    }
    default:
      return undefined;
  }
}

const truncate = (s: string) => (s.length > 200 ? `${s.slice(0, 197)}...` : s);

export function instrument(input: InstrumentInput): InstrumentOutput {
  const { source, file } = input;
  const parsed = parse(file, source);
  const errors = parsed.errors;
  if (errors.length > 0 || !parsed.program) {
    return { code: undefined, map: undefined, mutants: [], nextMutant: input.firstMutant, nextSite: input.firstSite, errors };
  }
  const lines = new LineIndex(source);
  const directives = new Directives(parsed.comments, source, lines);
  const enabled = input.mutators ? new Set(input.mutators) : undefined;
  const mutators: Mutator[] = ALL_MUTATORS.filter((m) => !enabled || enabled.has(m.name));
  const ranges = input.lines;

  const overlaps = (n: Node) => {
    if (!ranges) return true;
    const s = lines.line(n.start);
    const e = lines.line(Math.max(n.start, n.end - 1));
    return ranges.some(([a, b]) => s <= b && e >= a);
  };
  const inScope = (n: Node, placement: Placement) => {
    if (!ranges) return true;
    // Statement-level mutants span whole bodies; selecting one because an edit landed somewhere
    // inside would put "delete this function body" on every changed function. They are in scope
    // when the line they start on changed.
    if (placement === 'block' || placement === 'switch-case' || placement === 'for-test') {
      const s = lines.line(n.start);
      return ranges.some(([a, b]) => s >= a && s <= b);
    }
    return overlaps(n);
  };

  const candidates: Candidate[] = [];
  const loops: Node[] = [];
  const ancestors: Node[] = [];
  const scopes: string[] = [];
  const anonymousCounters: number[] = [0];
  const ordinals = new Map<string, number>();

  const place = (c: Candidate, ancestorsAtNode: readonly Node[]) => {
    const node = c.node;
    switch (c.placement) {
      case 'block':
      case 'statement':
      case 'switch-case':
      case 'for-test':
        c.target = node;
        return;
      case 'arrow-body': {
        const body = node.body as Node;
        c.target = body;
        c.targetText = 'undefined';
        return;
      }
      case 'expression': {
        let cur = node;
        let i = ancestorsAtNode.length - 1;
        const assignmentTarget = inAssignmentTarget(node, ancestorsAtNode);
        for (;;) {
          const parent = ancestorsAtNode[i];
          if (!(assignmentTarget && inAssignmentTarget(cur, ancestorsAtNode.slice(0, i + 1))) && canWrap(cur, parent)) break;
          if (!parent || (STATEMENT_BOUNDARY(parent) && parent !== node)) {
            c.ignoredBy = 'placement';
            c.statusReason = 'tzap cannot compile this mutant in place';
            return;
          }
          cur = parent;
          i--;
        }
        c.target = cur;
        c.targetText = source.slice(cur.start, node.start) + c.replacement + source.slice(node.end, cur.end);
        // An expression at the very start of an expression statement: a leading `(` would
        // otherwise be parsed as a call on the previous line when that line has no semicolon.
        for (let j = i; j >= 0; j--) {
          const a = ancestorsAtNode[j]!;
          if (STATEMENT_BOUNDARY(a)) {
            c.voidPrefix = a.type === 'ExpressionStatement' && a.start === cur.start;
            break;
          }
        }
        return;
      }
    }
  };

  const visit = (node: Node) => {
    if (isSkipped(node)) return;
    const parent = ancestors[ancestors.length - 1];
    if (LOOP_TYPES.has(node.type)) loops.push(node);

    const name = scopeName(node, parent, anonymousCounters[anonymousCounters.length - 1]!);
    if (name !== undefined && name.startsWith('<anonymous#')) anonymousCounters[anonymousCounters.length - 1]!++;
    if (name !== undefined) {
      scopes.push(name);
      anonymousCounters.push(0);
    }
    const scope = scopes.join('/');

    const subtreeStart = candidates.length;
    const ownStart = candidates.length;
    if (overlaps(node)) {
      const ctx = { source, parent, ancestors };
      for (const m of mutators) {
        for (const p of m.mutate(node, ctx)) {
          if (!inScope(node, p.placement)) continue;
          const c: Candidate = { mutatorName: m.name, node, replacement: p.replacement, placement: p.placement, scope };
          const line = lines.line(node.start);
          const reason = directives.ignoreReason(node.start, line, m.name);
          if (reason !== undefined) {
            c.ignoredBy = 'comment';
            c.statusReason = reason;
          } else if (input.filters) {
            for (const f of input.filters) {
              const r = f.filter({ mutatorName: m.name, node, ancestors, source });
              if (r !== undefined) {
                c.ignoredBy = f.name;
                c.statusReason = r;
                break;
              }
            }
          }
          if (c.ignoredBy === undefined) place(c, ancestors.slice());
          candidates.push(c);
        }
      }
    }
    const ownEnd = candidates.length;

    ancestors.push(node);
    for (const child of children(node)) visit(child);
    ancestors.pop();

    // Mutators with a scope filter (Stryker 10's CallExpression) keep their mutants on this
    // node only when the count of live mutants in the subtree satisfies it.
    for (const m of mutators) {
      if (!m.keep) continue;
      const own = candidates.slice(ownStart, ownEnd).filter((c) => c.mutatorName === m.name && !c.ignoredBy && !c.removed);
      if (own.length === 0) continue;
      const inScopeCount = candidates.slice(subtreeStart).filter((c) => !c.ignoredBy && !c.removed).length;
      if (!m.keep(inScopeCount)) for (const c of own) c.removed = true;
    }

    if (name !== undefined) {
      scopes.pop();
      anonymousCounters.pop();
    }
  };
  visit(parsed.program);

  // Number mutants and build descriptors.
  let nextMutant = input.firstMutant;
  let nextSite = input.firstSite;
  const live = candidates.filter((c) => !c.removed);
  const descriptors: MutantDescriptor[] = [];
  const byCandidate = new Map<Candidate, MutantDescriptor>();
  for (const c of live) {
    const original = source.slice(c.node.start, c.node.end);
    const key = [file, c.scope, c.mutatorName, original, c.replacement].join('\0');
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    const d: MutantDescriptor = {
      id: hash([file, c.scope, c.mutatorName, original, c.replacement, String(ordinal)]),
      num: c.ignoredBy ? -1 : nextMutant++,
      file,
      mutatorName: c.mutatorName,
      location: { start: lines.position(c.node.start), end: lines.position(c.node.end) },
      replacement: c.replacement,
      original: truncate(original),
      description: `replaced ${truncate(original.replace(/\s+/g, ' '))} with ${c.replacement}`,
      site: -1,
    };
    if (c.ignoredBy) {
      d.ignoredBy = c.ignoredBy;
      d.description = c.statusReason ?? d.description;
    }
    descriptors.push(d);
    byCandidate.set(c, d);
  }

  const placed = live.filter((c) => !c.ignoredBy);
  if (placed.length === 0 && loops.length === 0) {
    return { code: undefined, map: undefined, mutants: descriptors, nextMutant, nextSite, errors };
  }
  if (placed.length === 0) {
    // Loops alone are not worth instrumenting a file for: no mutant can be active in it.
    return { code: undefined, map: undefined, mutants: descriptors, nextMutant, nextSite, errors };
  }

  // Group by placement target.
  interface Group {
    kind: Placement;
    target: Node;
    entries: Array<{ num: number; text: string }>;
    site: number;
    voidPrefix: boolean;
  }
  const groups = new Map<string, Group>();
  for (const c of placed) {
    const target = c.target!;
    const kind: Placement = c.placement === 'arrow-body' ? 'expression' : c.placement;
    const key = `${kind}:${target.start}:${target.end}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind, target, entries: [], site: -1, voidPrefix: false };
      groups.set(key, g);
    }
    g.voidPrefix ||= c.voidPrefix === true;
    g.entries.push({ num: byCandidate.get(c)!.num, text: c.targetText ?? c.replacement });
  }
  for (const g of groups.values()) g.site = nextSite++;
  for (const c of placed) {
    const target = c.target!;
    const kind: Placement = c.placement === 'arrow-body' ? 'expression' : c.placement;
    byCandidate.get(c)!.site = groups.get(`${kind}:${target.start}:${target.end}`)!.site;
  }

  const R = RUNTIME_GLOBAL;
  const s = new MagicString(source);
  type Edit = { start: number; end: number; order: number; apply: () => void };
  const edits: Edit[] = [];
  let order = 0;

  for (const g of groups.values()) {
    const t = g.target;
    const hit = `${R}.c[${g.site}]++`;
    const active = (num: number) => `${R}.a===${num}`;
    switch (g.kind) {
      case 'expression': {
        const pre =
          (g.voidPrefix ? 'void ' : '') +
          '(' +
          g.entries.map((e) => `${active(e.num)}?(${R}.m(),${e.text}):`).join('') +
          `(${hit},`;
        edits.push({ start: t.start, end: t.end, order: order++, apply: () => { s.prependRight(t.start, pre); s.appendLeft(t.end, '))'); } });
        break;
      }
      case 'block': {
        const [e] = g.entries;
        const body = t.body as Node[];
        const directivesEnd = body.filter((x) => x.type === 'ExpressionStatement' && typeof x.directive === 'string').reduce((acc, x) => Math.max(acc, x.end), t.start + 1);
        const pre = `if(${active(e!.num)}){${R}.m();}else{${hit};`;
        edits.push({ start: t.start, end: t.end, order: order++, apply: () => { s.prependRight(directivesEnd, pre); s.appendLeft(t.end - 1, '}'); } });
        break;
      }
      case 'statement': {
        const [e] = g.entries;
        const pre = `if(${active(e!.num)}){${R}.m();}else{${hit};`;
        edits.push({ start: t.start, end: t.end, order: order++, apply: () => { s.prependRight(t.start, pre); s.appendLeft(t.end, '}'); } });
        break;
      }
      case 'switch-case': {
        const [e] = g.entries;
        const cons = t.consequent as Node[];
        const first = cons[0]!;
        const last = cons[cons.length - 1]!;
        const pre = `if(${active(e!.num)}){${R}.m();}else{${hit};`;
        edits.push({ start: t.start, end: t.end, order: order++, apply: () => { s.prependRight(first.start, pre); s.appendLeft(last.end, '}'); } });
        break;
      }
      case 'for-test': {
        const [e] = g.entries;
        const at = forTestOffset(source, t);
        const expression = `(${active(e!.num)}?(${R}.m(),false):(${hit},true))`;
        edits.push({ start: t.start, end: t.end, order: order++, apply: () => { s.appendLeft(at, expression); } });
        break;
      }
      default:
        break;
    }
  }

  const guard = `if(++${R}.l>${R}.L)${R}.x();`;
  for (const loop of loops) {
    const body = loop.body as Node;
    edits.push({
      start: loop.start,
      end: loop.end,
      order: order++,
      apply: () => {
        if (body.type === 'BlockStatement') s.prependRight(body.start + 1, guard);
        else {
          s.prependRight(body.start, `{${guard}`);
          s.appendLeft(body.end, '}');
        }
      },
    });
  }

  // Inner edits first: magic-string puts a later prependRight to the left of an earlier one at
  // the same offset, and a later appendLeft to the right, so outer constructs wrap inner ones.
  edits.sort((a, b) => a.end - a.start - (b.end - b.start) || a.order - b.order);
  for (const e of edits) e.apply();

  const maxSite = nextSite - 1;
  const program = parsed.program;
  const statements = program.body as Node[];
  const lastDirective = statements.filter((x) => x.type === 'ExpressionStatement' && typeof x.directive === 'string').pop();
  const firstStatement = statements.find((x) => !(x.type === 'ExpressionStatement' && typeof x.directive === 'string'));
  const headerAt = lastDirective ? lastDirective.end : firstStatement ? firstStatement.start : source.length;
  const header = runtimeHeader(maxSite);
  s.prependRight(headerAt, lastDirective ? `\n${header}\n` : `${header}\n`);

  const code = s.toString();
  const map = s.generateMap({ hires: 'boundary', source: file, includeContent: true });
  return { code, map, mutants: descriptors, nextMutant, nextSite, errors };
}
