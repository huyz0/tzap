import * as weaponRegex from 'weapon-regex';
import { type Node, isIdentifier, isNode, isStringLiteral, isTemplateLiteral } from './ast.js';
import { findToken } from './text.js';

/**
 * How a mutant is compiled into the schemata.
 *
 * - `expression`: the node is replaced, as an expression, by `replacement`.
 * - `arrow-body`: an arrow's concise body is replaced by `undefined`; the arrow itself, its
 *   name, parameters and `async` stay, so the only change is the returned value.
 * - `block`: a block's statements are skipped.
 * - `statement`: a statement is skipped.
 * - `switch-case`: a case's consequent is skipped, so control falls through.
 * - `for-test`: an absent `for(;;)` test becomes `false`.
 */
export type Placement = 'expression' | 'arrow-body' | 'block' | 'statement' | 'switch-case' | 'for-test';

export interface Proposal {
  /** Text of the mutated node, reported as the mutant's replacement. */
  replacement: string;
  placement: Placement;
}

export interface MutatorContext {
  source: string;
  parent: Node | undefined;
  /** Ancestors, root first; the last element is the parent. */
  ancestors: readonly Node[];
}

export interface Mutator {
  readonly name: string;
  mutate(node: Node, ctx: MutatorContext): Proposal[];
  /**
   * Stryker 10's filter: given the (non-ignored) mutants in this node's subtree including its
   * own, decide whether this mutator's mutants on the node are kept.
   */
  keep?(mutantsInScope: number): boolean;
}

const text = (ctx: MutatorContext, n: Node) => ctx.source.slice(n.start, n.end);
const expr = (replacement: string): Proposal => ({ replacement, placement: 'expression' });

/** Replaces the operator token that lies between two operands. */
function swapOperator(ctx: MutatorContext, node: Node, left: Node, right: Node, op: string, next: string): string | undefined {
  const at = findToken(ctx.source, op, left.end, right.start);
  if (at === -1) return undefined;
  return ctx.source.slice(node.start, at) + next + ctx.source.slice(at + op.length, node.end);
}

const isStringy = (n: unknown) => isStringLiteral(n) || isTemplateLiteral(n);

// --- ArithmeticOperator -------------------------------------------------------------------

const ARITHMETIC: Record<string, string> = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };

export const arithmeticOperator: Mutator = {
  name: 'ArithmeticOperator',
  mutate(node, ctx) {
    if (node.type !== 'BinaryExpression') return [];
    const op = node.operator as string;
    const next = ARITHMETIC[op];
    if (!next) return [];
    const left = node.left as Node;
    const right = node.right as Node;
    const leftType = left.type === 'BinaryExpression' ? (left.right as Node) : left;
    if (isStringy(right) || isStringy(leftType)) return [];
    const r = swapOperator(ctx, node, left, right, op, next);
    return r ? [expr(r)] : [];
  },
};

// --- ArrayDeclaration ---------------------------------------------------------------------

export const arrayDeclaration: Mutator = {
  name: 'ArrayDeclaration',
  mutate(node, ctx) {
    if (node.type === 'ArrayExpression') {
      return [expr((node.elements as unknown[]).length ? '[]' : '["Stryker was here"]')];
    }
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && isIdentifier(node.callee, 'Array')) {
      const args = (node.arguments as Node[]).length ? '' : '[]';
      const prefix = node.type === 'NewExpression' ? 'new ' : '';
      void ctx;
      return [expr(`${prefix}Array(${args})`)];
    }
    return [];
  },
};

// --- ArrowFunction ------------------------------------------------------------------------

export const arrowFunction: Mutator = {
  name: 'ArrowFunction',
  mutate(node) {
    if (node.type !== 'ArrowFunctionExpression') return [];
    const body = node.body as Node;
    if (body.type === 'BlockStatement' || node.expression === false) return [];
    if (isIdentifier(body, 'undefined')) return [];
    return [{ replacement: '() => undefined', placement: 'arrow-body' }];
  },
};

// --- AssignmentOperator -------------------------------------------------------------------

const ASSIGNMENT: Record<string, string> = {
  '+=': '-=',
  '-=': '+=',
  '*=': '/=',
  '/=': '*=',
  '%=': '*=',
  '<<=': '>>=',
  '>>=': '<<=',
  '&=': '|=',
  '|=': '&=',
  '&&=': '||=',
  '||=': '&&=',
  '??=': '&&=',
};
const STRING_SAFE_ASSIGNMENT = new Set(['&&=', '||=', '??=']);

export const assignmentOperator: Mutator = {
  name: 'AssignmentOperator',
  mutate(node, ctx) {
    if (node.type !== 'AssignmentExpression') return [];
    const op = node.operator as string;
    const next = ASSIGNMENT[op];
    if (!next) return [];
    if (isStringy(node.right) && !STRING_SAFE_ASSIGNMENT.has(op)) return [];
    const r = swapOperator(ctx, node, node.left as Node, node.right as Node, op, next);
    return r ? [expr(r)] : [];
  },
};

// --- BlockStatement -----------------------------------------------------------------------

function containsSuperCall(node: Node): boolean {
  let found = false;
  const visit = (n: Node) => {
    if (found) return;
    if (n.type === 'CallExpression' && isNode(n.callee) && n.callee.type === 'Super') {
      found = true;
      return;
    }
    // A nested function has its own `super` binding only if it is a method; arrows share it.
    for (const key of Object.keys(n)) {
      if (key === 'parent') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach((x) => isNode(x) && visit(x));
      else if (isNode(v)) visit(v);
    }
  };
  visit(node);
  return found;
}

/** Stryker #2314/#2474: emptying such a constructor makes the class fail to construct at all. */
function isInvalidConstructorBody(block: Node, ctx: MutatorContext): boolean {
  const fn = ctx.parent;
  const method = ctx.ancestors[ctx.ancestors.length - 2];
  if (!fn || fn.type !== 'FunctionExpression' || !method || method.type !== 'MethodDefinition' || method.kind !== 'constructor') {
    return false;
  }
  const hasParamProps = (fn.params as Node[]).some((p) => p.type === 'TSParameterProperty');
  const classBody = ctx.ancestors[ctx.ancestors.length - 3];
  const hasInitialisedProps =
    !!classBody &&
    classBody.type === 'ClassBody' &&
    (classBody.body as Node[]).some((m) => (m.type === 'PropertyDefinition' || m.type === 'AccessorProperty') && m.value !== null && m.value !== undefined);
  return (hasParamProps || hasInitialisedProps) && containsSuperCall(block);
}

export const blockStatement: Mutator = {
  name: 'BlockStatement',
  mutate(node, ctx) {
    if (node.type !== 'BlockStatement') return [];
    const statements = (node.body as Node[]).filter((s) => !(s.type === 'ExpressionStatement' && typeof s.directive === 'string'));
    if (statements.length === 0) return [];
    if (isInvalidConstructorBody(node, ctx)) return [];
    return [{ replacement: '{}', placement: 'block' }];
  },
};

// --- BooleanLiteral -----------------------------------------------------------------------

export const booleanLiteral: Mutator = {
  name: 'BooleanLiteral',
  mutate(node, ctx) {
    if (node.type === 'Literal' && typeof node.value === 'boolean') {
      return [expr(node.value ? 'false' : 'true')];
    }
    if (node.type === 'UnaryExpression' && node.operator === '!' && node.prefix !== false) {
      return [expr(text(ctx, node.argument as Node))];
    }
    return [];
  },
};

// --- ConditionalExpression ----------------------------------------------------------------

const BOOLEAN_OPERATORS = new Set(['!=', '!==', '&&', '<', '<=', '==', '===', '>', '>=', '||']);

export const conditionalExpression: Mutator = {
  name: 'ConditionalExpression',
  mutate(node, ctx) {
    const p = ctx.parent;
    const isTestOf = (types: string[]) => !!p && types.includes(p.type) && p.test === node;
    if (isTestOf(['ForStatement', 'WhileStatement', 'DoWhileStatement'])) return [expr('false')];
    if (isTestOf(['IfStatement'])) return [expr('true'), expr('false')];
    if ((node.type === 'BinaryExpression' || node.type === 'LogicalExpression') && BOOLEAN_OPERATORS.has(node.operator as string)) {
      if (p && p.type === 'LogicalExpression') {
        if (p.operator === '||') return [expr('false')];
        if (p.operator === '&&') return [expr('true')];
      }
      return [expr('true'), expr('false')];
    }
    if (node.type === 'ForStatement' && (node.test === null || node.test === undefined)) {
      return [{ replacement: forWithFalseTest(ctx, node), placement: 'for-test' }];
    }
    if (node.type === 'SwitchCase' && (node.consequent as Node[]).length > 0) {
      if ((node.consequent as Node[]).some(isLexicalDeclaration)) return [];
      const head = ctx.source.slice(node.start, (node.consequent as Node[])[0]!.start).trimEnd();
      return [{ replacement: head, placement: 'switch-case' }];
    }
    return [];
  },
};

/** The offset just after the first `;` of a `for (init; test; update)` header. */
export function forTestOffset(source: string, node: Node): number {
  const init = node.init as Node | null;
  const from = init ? init.end : source.indexOf('(', node.start) + 1;
  return findToken(source, ';', from, (node.body as Node).start) + 1;
}

function forWithFalseTest(ctx: MutatorContext, node: Node): string {
  const at = forTestOffset(ctx.source, node);
  return ctx.source.slice(node.start, at) + 'false' + ctx.source.slice(at, node.end);
}

/** Wrapping a case in a block would change the scope of these, which other cases can see. */
function isLexicalDeclaration(s: Node): boolean {
  return (
    (s.type === 'VariableDeclaration' && s.kind !== 'var') ||
    s.type === 'ClassDeclaration' ||
    s.type === 'FunctionDeclaration'
  );
}

// --- CallExpression (Stryker 10's "empty expression") --------------------------------------

const isSuperCall = (n: Node) => isNode(n.callee) && n.callee.type === 'Super';

export const callExpression: Mutator = {
  name: 'CallExpression',
  mutate(node) {
    if (node.type === 'ExpressionStatement' && typeof node.directive !== 'string') {
      const e = node.expression as Node;
      if (e.type === 'CallExpression' && !isSuperCall(e)) return [{ replacement: ';', placement: 'statement' }];
    }
    if (node.type === 'ThrowStatement' && isNode(node.argument) && node.argument.type === 'NewExpression') {
      return [{ replacement: ';', placement: 'statement' }];
    }
    return [];
  },
  keep: (mutantsInScope) => mutantsInScope === 1,
};

// --- EqualityOperator ---------------------------------------------------------------------

const EQUALITY: Record<string, string[]> = {
  '<': ['<=', '>='],
  '<=': ['<', '>'],
  '>': ['>=', '<='],
  '>=': ['>', '<'],
  '==': ['!='],
  '!=': ['=='],
  '===': ['!=='],
  '!==': ['==='],
};

export const equalityOperator: Mutator = {
  name: 'EqualityOperator',
  mutate(node, ctx) {
    if (node.type !== 'BinaryExpression') return [];
    const op = node.operator as string;
    const nexts = EQUALITY[op];
    if (!nexts) return [];
    const out: Proposal[] = [];
    for (const next of nexts) {
      const r = swapOperator(ctx, node, node.left as Node, node.right as Node, op, next);
      if (r) out.push(expr(r));
    }
    return out;
  },
};

// --- LogicalOperator ----------------------------------------------------------------------

const LOGICAL: Record<string, string> = { '&&': '||', '||': '&&', '??': '&&' };

export const logicalOperator: Mutator = {
  name: 'LogicalOperator',
  mutate(node, ctx) {
    if (node.type !== 'LogicalExpression') return [];
    const op = node.operator as string;
    const next = LOGICAL[op];
    if (!next) return [];
    const left = node.left as Node;
    const right = node.right as Node;
    const r = swapOperator(ctx, node, left, right, op, next);
    if (!r) return [];
    // `a ?? b ?? c` is `(a ?? b) ?? c`; swapping the outer operator yields `a ?? b && c`, which
    // JavaScript refuses to parse: `??` cannot mix with `&&` or `||` without parentheses.
    // An operand wrapped in its own parentheses starts after (left) or ends before (right) its parent.
    const bare = (n: Node) => n.type === 'LogicalExpression' && n.operator === '??' && (n === left ? n.start === node.start : n.end === node.end);
    if (op === '??' && (bare(left) || bare(right))) {
      const at = r.length - (node.end - right.start);
      const l = bare(left) ? `(${ctx.source.slice(left.start, left.end)})` : ctx.source.slice(left.start, left.end);
      const mid = r.slice(left.end - node.start, at);
      const rt = bare(right) ? `(${ctx.source.slice(right.start, right.end)})` : ctx.source.slice(right.start, right.end);
      return [expr(ctx.source.slice(node.start, left.start) + l + mid + rt)];
    }
    return [expr(r)];
  },
};

// --- MethodExpression ---------------------------------------------------------------------

const METHODS = new Map<string, string | null>([
  ['charAt', null],
  ['endsWith', 'startsWith'],
  ['every', 'some'],
  ['filter', null],
  ['reverse', null],
  ['slice', null],
  ['sort', null],
  ['substr', null],
  ['substring', null],
  ['toLocaleLowerCase', 'toLocaleUpperCase'],
  ['toLowerCase', 'toUpperCase'],
  ['trim', null],
  ['trimEnd', 'trimStart'],
  ['min', 'max'],
  ['setDate', 'setTime'],
  ['setFullYear', 'setMonth'],
  ['setHours', 'setMinutes'],
  ['setSeconds', 'setMilliseconds'],
  ['setUTCDate', 'setTime'],
  ['setUTCFullYear', 'setUTCMonth'],
  ['setUTCHours', 'setUTCMinutes'],
  ['setUTCSeconds', 'setUTCMilliseconds'],
]);
for (const [key, value] of [...METHODS]) {
  if (value && key !== 'getUTCDate' && key !== 'setUTCDate') METHODS.set(value, key);
}

export const methodExpression: Mutator = {
  name: 'MethodExpression',
  mutate(node, ctx) {
    if (node.type !== 'CallExpression') return [];
    const callee = node.callee as Node;
    if (callee.type !== 'MemberExpression' || callee.computed === true || !isIdentifier(callee.property)) return [];
    const name = (callee.property as Node & { name: string }).name;
    const next = METHODS.get(name);
    if (next === undefined) return [];
    if (next === null) return [expr(text(ctx, callee.object as Node))];
    const prop = callee.property as Node;
    return [expr(ctx.source.slice(node.start, prop.start) + next + ctx.source.slice(prop.end, node.end))];
  },
};

// --- ObjectLiteral ------------------------------------------------------------------------

export const objectLiteral: Mutator = {
  name: 'ObjectLiteral',
  mutate(node) {
    if (node.type !== 'ObjectExpression' || (node.properties as Node[]).length === 0) return [];
    return [expr('{}')];
  },
};

// --- OptionalChaining ---------------------------------------------------------------------

export const optionalChaining: Mutator = {
  name: 'OptionalChaining',
  mutate(node, ctx) {
    if (node.optional !== true) return [];
    if (node.type === 'MemberExpression') {
      const obj = node.object as Node;
      const at = findToken(ctx.source, '?.', obj.end, (node.property as Node).start);
      if (at === -1) return [];
      const dot = node.computed ? '' : '.';
      return [expr(ctx.source.slice(node.start, at) + dot + ctx.source.slice(at + 2, node.end))];
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee as Node;
      const at = findToken(ctx.source, '?.', callee.end, node.end);
      if (at === -1) return [];
      return [expr(ctx.source.slice(node.start, at) + ctx.source.slice(at + 2, node.end))];
    }
    return [];
  },
};

// --- Regex --------------------------------------------------------------------------------

function mutatePattern(pattern: string, flags: string | undefined): string[] {
  if (!pattern.length) return [];
  try {
    return weaponRegex.mutate(pattern, flags, { mutationLevels: [1] }).map((m: { pattern: string }) => m.pattern);
  } catch {
    return [];
  }
}

export const regex: Mutator = {
  name: 'Regex',
  mutate(node, ctx) {
    if (node.type === 'Literal' && isNode(node.regex as Node) === false && node.regex) {
      const { pattern, flags } = node.regex as { pattern: string; flags: string };
      return mutatePattern(pattern, flags).map((p) => expr(`/${p}/${flags}`));
    }
    const p = ctx.parent;
    if (
      isStringLiteral(node) &&
      p &&
      p.type === 'NewExpression' &&
      isIdentifier(p.callee, 'RegExp') &&
      (p.arguments as Node[])[0] === node
    ) {
      const flagsArg = (p.arguments as Node[])[1];
      const flags = isStringLiteral(flagsArg) ? flagsArg.value : undefined;
      return mutatePattern(node.value, flags).map((pat) => expr(JSON.stringify(pat)));
    }
    return [];
  },
};

// --- StringLiteral ------------------------------------------------------------------------

function isValidStringParent(node: Node, ctx: MutatorContext): boolean {
  const p = ctx.parent;
  if (!p) return true;
  switch (p.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportDefaultDeclaration':
    case 'ImportExpression':
    case 'ImportAttribute':
    case 'TSExternalModuleReference':
    case 'JSXAttribute':
    case 'ExpressionStatement':
    case 'TSLiteralType':
      return false;
    case 'Property':
      return p.key !== node || p.computed === true;
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
    case 'TSAbstractMethodDefinition':
    case 'TSAbstractPropertyDefinition':
      return p.key !== node;
    case 'CallExpression':
      return !(isIdentifier(p.callee, 'require') || isIdentifier(p.callee, 'Symbol') || (isNode(p.callee) && p.callee.type === 'Import'));
    default:
      return true;
  }
}

export const stringLiteral: Mutator = {
  name: 'StringLiteral',
  mutate(node, ctx) {
    if (node.type === 'TemplateLiteral') {
      const quasis = node.quasis as Array<Node & { value: { raw: string } }>;
      const empty = quasis.length === 1 && quasis[0]!.value.raw.length === 0;
      return [expr(empty ? '`Stryker was here!`' : '``')];
    }
    if (isStringLiteral(node) && isValidStringParent(node, ctx)) {
      return [expr(node.value.length === 0 ? '"Stryker was here!"' : '""')];
    }
    return [];
  },
};

// --- UnaryOperator ------------------------------------------------------------------------

export const unaryOperator: Mutator = {
  name: 'UnaryOperator',
  mutate(node, ctx) {
    if (node.type !== 'UnaryExpression' || node.prefix === false) return [];
    const arg = node.argument as Node;
    switch (node.operator) {
      case '+':
        return [expr(`-${ctx.source.slice(node.start + 1, node.end)}`)];
      case '-':
        return [expr(`+${ctx.source.slice(node.start + 1, node.end)}`)];
      case '~':
        return [expr(text(ctx, arg))];
      default:
        return [];
    }
  },
};

// --- UpdateOperator -----------------------------------------------------------------------

export const updateOperator: Mutator = {
  name: 'UpdateOperator',
  mutate(node, ctx) {
    if (node.type !== 'UpdateExpression') return [];
    const op = node.operator as string;
    const next = op === '++' ? '--' : '++';
    const arg = node.argument as Node;
    const r = node.prefix
      ? next + ctx.source.slice(node.start + 2, node.end)
      : ctx.source.slice(node.start, arg.end) + ctx.source.slice(arg.end, node.end).replace(op, next);
    return [expr(r)];
  },
};

/** Stryker 10's set, in Stryker's order, under Stryker's names, so inventories compare mutant for mutant. */
export const ALL_MUTATORS: readonly Mutator[] = [
  arithmeticOperator,
  arrayDeclaration,
  arrowFunction,
  blockStatement,
  booleanLiteral,
  conditionalExpression,
  callExpression,
  equalityOperator,
  logicalOperator,
  methodExpression,
  objectLiteral,
  stringLiteral,
  unaryOperator,
  updateOperator,
  regex,
  optionalChaining,
  assignmentOperator,
];

export const MUTATOR_NAMES: readonly string[] = ALL_MUTATORS.map((m) => m.name);
