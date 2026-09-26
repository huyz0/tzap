/** The slice of the ESTree / TS-ESTree shape tzap relies on. oxc emits UTF-16 offsets. */
export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as Node).type === 'string' && typeof (v as Node).start === 'number';
}

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'parent', 'raw', 'value', 'regex', 'bigint']);

/** Child nodes in source order. */
export function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const x of v) if (isNode(x)) out.push(x);
    } else if (isNode(v)) {
      out.push(v);
    }
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

export const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

export const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Babel-parity list of type-only nodes whose whole subtree is never mutated (Stryker's `isTypeNode`). */
const SKIPPED_TYPES = new Set([
  'TSAsExpression',
  'TSInterfaceDeclaration',
  'TSTypeAnnotation',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSDeclareFunction',
  'TSTypeParameterInstantiation',
  'TSTypeParameterDeclaration',
  'ImportDeclaration',
  'TSImportEqualsDeclaration',
  'Decorator',
]);

/** TS nodes that carry runtime code and are therefore traversed. Every other TS* node is a type. */
const RUNTIME_TS_TYPES = new Set([
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'TSParameterProperty',
  'TSModuleDeclaration',
  'TSModuleBlock',
  'TSExportAssignment',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
]);

export function isSkipped(node: Node): boolean {
  if (SKIPPED_TYPES.has(node.type)) return true;
  if (node.type.startsWith('TS') && !RUNTIME_TS_TYPES.has(node.type)) return true;
  if (node.type === 'VariableDeclaration' && node.declare === true) return true;
  if (node.type === 'TSModuleDeclaration' && node.declare === true) return true;
  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.declare === true) return true;
  // Overload signatures and abstract members have no body to mutate.
  if (node.type === 'FunctionDeclaration' && node.body === null) return true;
  return false;
}

export function isStringLiteral(n: unknown): n is Node & { value: string } {
  return isNode(n) && n.type === 'Literal' && typeof n.value === 'string';
}

export function isTemplateLiteral(n: unknown): boolean {
  return isNode(n) && n.type === 'TemplateLiteral';
}

export function isIdentifier(n: unknown, name?: string): n is Node & { name: string } {
  return isNode(n) && n.type === 'Identifier' && (name === undefined || n.name === name);
}
