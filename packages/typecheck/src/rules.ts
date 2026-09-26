/**
 * Type-directed generation without a checker: rules that decide from the source alone (the
 * mutated node, its ancestors, and declarations in the same file) that a mutant cannot compile
 * under `strict`. Each rule is a {@link MutantFilter} for `@tzap/instrument`'s `filters` option;
 * a dropped mutant is reported `Ignored` with the rule's reason.
 *
 * Every rule was measured for precision against the checker on the tzap sources and the
 * typed-vitest fixture (7.9k mutants). `TYPE_RULES` marks `shipped` only the rules that measured
 * 100% precision; the others (the roadmap's naive ArrowFunction rule among them) are exported for
 * measurement and never enabled by default.
 *
 * All rules assume `strict` (at least `strictNullChecks`); they must be off for a project that is
 * not strict, which only the caller (who reads the tsconfig) can know.
 */
import type { MutantFilter, Node } from '@tzap/instrument';

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const SCOPES = new Set(['Program', 'BlockStatement', 'StaticBlock', 'TSModuleBlock']);

const ann = (n: Node | undefined | null): Node | undefined => {
  const t = n?.typeAnnotation as Node | null | undefined;
  if (!t) return undefined;
  return t.type === 'TSTypeAnnotation' ? ((t.typeAnnotation as Node | undefined) ?? undefined) : t;
};

const nameOf = (n: Node | undefined | null): string | undefined => (n && n.type === 'Identifier' ? (n.name as string) : undefined);

/** Interfaces and type aliases declared at the top level of the file, by name. */
const typeDecls = new WeakMap<Node, Map<string, Node[]>>();
function declsOf(program: Node | undefined): Map<string, Node[]> {
  if (!program) return new Map();
  let map = typeDecls.get(program);
  if (map) return map;
  map = new Map();
  for (let stmt of program.body as Node[]) {
    if ((stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') && stmt.declaration) stmt = stmt.declaration as Node;
    if (stmt.type === 'TSInterfaceDeclaration' || stmt.type === 'TSTypeAliasDeclaration') {
      const name = nameOf(stmt.id as Node)!;
      map.set(name, [...(map.get(name) ?? []), stmt]);
    }
  }
  typeDecls.set(program, map);
  return map;
}

const programOf = (ancestors: readonly Node[]) => (ancestors[0]?.type === 'Program' ? ancestors[0] : undefined);

/** Resolves a type reference to a same-file declaration, one alias level at a time (bounded). */
function resolve(t: Node | undefined, program: Node | undefined, depth = 0): Node | undefined {
  if (!t || depth > 4) return t;
  if (t.type === 'TSParenthesizedType') return resolve(t.typeAnnotation as Node, program, depth + 1);
  if (t.type !== 'TSTypeReference' || t.typeArguments) return t;
  const name = nameOf(t.typeName as Node);
  const decls = name ? declsOf(program).get(name) : undefined;
  if (!decls || decls.length !== 1) return t;
  const d = decls[0]!;
  if (d.type === 'TSInterfaceDeclaration') return d;
  if (d.typeParameters) return t;
  return resolve(d.typeAnnotation as Node, program, depth + 1);
}

const NULLISH = new Set(['TSNullKeyword', 'TSUndefinedKeyword']);
const LOOSE = new Set(['TSAnyKeyword', 'TSUnknownKeyword', 'TSVoidKeyword']);

/** Union members, flattening nested unions and resolving same-file aliases. */
function members(t: Node | undefined, program: Node | undefined): Node[] {
  const r = resolve(t, program);
  if (!r) return [];
  if (r.type === 'TSUnionType') return (r.types as Node[]).flatMap((x) => members(x, program));
  return [r];
}

/** The type visibly includes `null` or `undefined`. */
function nullable(t: Node | undefined, program: Node | undefined): boolean {
  return members(t, program).some((m) => NULLISH.has(m.type));
}

/** The type visibly excludes `null` and `undefined`: every member is a known, non-nullish, non-loose type. */
function visiblyNonNullable(t: Node | undefined, program: Node | undefined): boolean {
  const ms = members(t, program);
  if (ms.length === 0) return false;
  return ms.every((m) => {
    if (NULLISH.has(m.type) || LOOSE.has(m.type)) return false;
    // An unresolved reference may be an alias for anything, a type parameter may be instantiated with undefined.
    if (m.type === 'TSTypeReference') return nameOf(m.typeName as Node) !== undefined && KNOWN_NON_NULLISH.has(nameOf(m.typeName as Node)!);
    return NON_NULLISH_TYPES.has(m.type);
  });
}
const NON_NULLISH_TYPES = new Set([
  'TSStringKeyword',
  'TSNumberKeyword',
  'TSBigIntKeyword',
  'TSBooleanKeyword',
  'TSSymbolKeyword',
  'TSObjectKeyword',
  'TSArrayType',
  'TSTupleType',
  'TSTypeLiteral',
  'TSFunctionType',
  'TSLiteralType',
  'TSTemplateLiteralType',
  'TSInterfaceDeclaration',
]);
const KNOWN_NON_NULLISH = new Set(['Array', 'ReadonlyArray', 'Map', 'Set', 'ReadonlyMap', 'ReadonlySet', 'Record', 'Promise', 'RegExp', 'Date', 'Error']);

/** The declaration of `name` visible at the node: a parameter or a variable of an enclosing scope. */
function declarationOf(name: string, ancestors: readonly Node[]): { type: Node | undefined; optional: boolean; init?: Node } | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]!;
    if (FUNCTIONS.has(a.type)) {
      for (let p of a.params as Node[]) {
        if (p.type === 'TSParameterProperty') p = p.parameter as Node;
        const target = p.type === 'AssignmentPattern' ? (p.left as Node) : p;
        if (nameOf(target) === name) return { type: ann(target), optional: target.optional === true || p.type === 'AssignmentPattern' };
      }
    }
    if (SCOPES.has(a.type)) {
      for (let s of a.body as Node[]) {
        if (s.type === 'ExportNamedDeclaration' && s.declaration) s = s.declaration as Node;
        if (s.type !== 'VariableDeclaration') continue;
        for (const d of s.declarations as Node[]) {
          if (nameOf(d.id as Node) === name) return { type: ann(d.id as Node), optional: false, init: (d.init as Node) ?? undefined };
        }
      }
    }
  }
  return undefined;
}

/** Members named `prop` declared in same-file interfaces and object type literals. */
function propertyDeclarations(prop: string, program: Node | undefined): Node[] {
  const out: Node[] = [];
  for (const decls of declsOf(program).values()) {
    for (const d of decls) {
      const body = d.type === 'TSInterfaceDeclaration' ? ((d.body as Node).body as Node[]) : d.typeAnnotation && (d.typeAnnotation as Node).type === 'TSTypeLiteral' ? ((d.typeAnnotation as Node).members as Node[]) : [];
      for (const m of body) if (m.type === 'TSPropertySignature' && !m.computed && nameOf(m.key as Node) === prop) out.push(m);
    }
  }
  return out;
}

const enclosingFunction = (ancestors: readonly Node[]) => {
  for (let i = ancestors.length - 1; i >= 0; i--) if (FUNCTIONS.has(ancestors[i]!.type)) return ancestors[i];
  return undefined;
};

/** The declared type a function's returned values must have: the return annotation, `Promise<T>` unwrapped for async functions. */
function returnTarget(fn: Node | undefined): Node | undefined {
  if (!fn || fn.generator) return undefined;
  const t = ann(fn.returnType as Node);
  if (!t) return undefined;
  if (fn.async) {
    if (t.type === 'TSTypeReference' && nameOf(t.typeName as Node) === 'Promise') return ((t.typeArguments as Node | undefined)?.params as Node[] | undefined)?.[0];
    return undefined;
  }
  return t;
}

/** The declared type the value of `node` must have where it stands, when visible: a typed variable, a return, an arrow body. */
function targetType(node: Node, ancestors: readonly Node[]): Node | undefined {
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return undefined;
  if (parent.type === 'VariableDeclarator' && parent.init === node) return ann(parent.id as Node);
  if (parent.type === 'ReturnStatement') return returnTarget(enclosingFunction(ancestors));
  if (parent.type === 'ArrowFunctionExpression' && parent.body === node) return returnTarget(parent);
  if (parent.type === 'TSSatisfiesExpression' && parent.expression === node) return parent.typeAnnotation as Node;
  if (parent.type === 'PropertyDefinition' && parent.value === node) return ann(parent);
  return undefined;
}

// --- Rules -------------------------------------------------------------------------------

/**
 * `BlockStatement` → `{}` on the body of a function whose declared return type needs a value
 * (TS2355), of a getter (TS2378), or of a function returning `never` (TS2534).
 */
export const returningBodyRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'BlockStatement') return undefined;
  const fn = ancestors[ancestors.length - 1];
  if (!fn || !FUNCTIONS.has(fn.type) || fn.body !== node || fn.generator) return undefined;
  const owner = ancestors[ancestors.length - 2];
  if (owner && (owner.type === 'MethodDefinition' || owner.type === 'Property') && owner.kind === 'get') return 'type-invalid: a getter must return a value';
  const t = returnTarget(fn);
  if (!t) return undefined;
  if (t.type === 'TSTypePredicate') return t.asserts ? undefined : 'type-invalid: a type predicate must return a value';
  if (t.type === 'TSNeverKeyword') return 'type-invalid: a function returning never cannot end';
  const program = programOf(ancestors);
  const ms = members(t, program);
  if (ms.length === 0 || ms.some((m) => NULLISH.has(m.type) || LOOSE.has(m.type) || m.type === 'TSNeverKeyword')) return undefined;
  return 'type-invalid: the declared return type needs a value';
};

/** Whether a type (after same-file resolution) visibly has a required property. */
function hasRequiredProperty(t: Node | undefined, program: Node | undefined): boolean {
  const ms = members(t, program);
  if (ms.length === 0) return false;
  return ms.every((m) => {
    const body = m.type === 'TSInterfaceDeclaration' ? ((m.body as Node).body as Node[]) : m.type === 'TSTypeLiteral' ? (m.members as Node[]) : undefined;
    if (!body) return false;
    return body.some((x) => (x.type === 'TSPropertySignature' || x.type === 'TSMethodSignature') && x.optional !== true);
  });
}

/** `ObjectLiteral` → `{}` where the literal's declared target type (same file) has a required property (TS2739/TS2741). */
export const requiredPropertiesRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'ObjectLiteral') return undefined;
  const t = targetType(node, ancestors);
  if (!t) return undefined;
  return hasRequiredProperty(t, programOf(ancestors)) ? 'type-invalid: the declared type has required properties' : undefined;
};

/** Visits every node under `root` (no parent tracking). */
function* walk(root: Node): Generator<Node> {
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    yield n;
    for (const k of Object.keys(n)) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) {
        for (const x of v) if (x && typeof x === 'object' && typeof (x as Node).type === 'string') stack.push(x as Node);
      } else if (v && typeof v === 'object' && typeof (v as Node).type === 'string') stack.push(v as Node);
    }
  }
}

const OBJECT_PROTOTYPE = new Set(['constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf']);

/** `ObjectLiteral` → `{}` initialising an unannotated `const` whose own keys are read later in the same scope (TS2339). */
export const usedKeysRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'ObjectLiteral') return undefined;
  const decl = ancestors[ancestors.length - 1];
  const stmt = ancestors[ancestors.length - 2];
  if (!decl || decl.type !== 'VariableDeclarator' || decl.init !== node || ann(decl.id as Node) || stmt?.kind !== 'const') return undefined;
  const name = nameOf(decl.id as Node);
  if (!name) return undefined;
  const keys = new Set(
    (node.properties as Node[]).flatMap((p) => (p.type === 'Property' && !p.computed ? [nameOf(p.key as Node) ?? (typeof (p.key as Node).value === 'string' ? ((p.key as Node).value as string) : '')] : [])),
  );
  const scope = [...ancestors].reverse().find((a) => SCOPES.has(a.type));
  if (!scope) return undefined;
  for (const n of walk(scope)) {
    if (n.type !== 'MemberExpression' || n.computed || nameOf(n.object as Node) !== name) continue;
    const prop = nameOf(n.property as Node);
    if (prop && keys.has(prop) && !OBJECT_PROTOTYPE.has(prop)) return 'type-invalid: a key of the literal is read later';
  }
  return undefined;
};

/**
 * `ArrowFunction` → `() => undefined` bound to an unannotated `const` that the file calls with
 * arguments (TS2554), or to a `const` annotated with a function type that returns a value.
 */
export const calledArrowRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'ArrowFunction') return undefined;
  const decl = ancestors[ancestors.length - 1];
  const stmt = ancestors[ancestors.length - 2];
  if (!decl || decl.type !== 'VariableDeclarator' || decl.init !== node || stmt?.kind !== 'const') return undefined;
  const name = nameOf(decl.id as Node);
  if (!name) return undefined;
  const program = programOf(ancestors);
  const t = ann(decl.id as Node);
  if (t) {
    if (t.type !== 'TSFunctionType') return undefined;
    const r = ann(t.returnType as Node);
    if (!r) return undefined;
    const ms = members(r, program);
    return ms.length > 0 && ms.every((m) => !NULLISH.has(m.type) && !LOOSE.has(m.type)) ? 'type-invalid: the declared function type returns a value' : undefined;
  }
  if ((node.params as Node[]).length === 0 || !program) return undefined;
  for (const n of walk(program)) {
    if (n.type === 'CallExpression' && nameOf(n.callee as Node) === name && (n.arguments as Node[]).length > 0) return 'type-invalid: called with arguments';
  }
  return undefined;
};

/** The roadmap's naive rule, kept for measurement only: `ArrowFunction` whose own declared return type is non-void. */
export const declaredReturnArrowRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'ArrowFunction') return undefined;
  const t = ann(node.returnType as Node);
  if (!t) return undefined;
  const ms = members(t, programOf(ancestors));
  return ms.length > 0 && ms.every((m) => !NULLISH.has(m.type) && !LOOSE.has(m.type)) ? 'type-invalid: declared non-void return' : undefined;
};

/** Whether an expression is visibly possibly-nullish from the source alone. */
function visiblyNullish(e: Node, ancestors: readonly Node[]): boolean {
  const program = programOf(ancestors);
  // `a?.b` is nullish when `a` is (or `b` is declared so); `?.` on a non-nullable receiver is not.
  if (e.type === 'ChainExpression') {
    const inner = e.expression as Node;
    if (inner.type === 'MemberExpression') return visiblyNullish(inner.object as Node, ancestors) || visiblyNullish({ ...inner, object: { type: 'ThisExpression', start: 0, end: 0 } } as Node, ancestors);
    if (inner.type === 'CallExpression') return visiblyNullish(inner, ancestors);
    return false;
  }
  if (e.type === 'Identifier') {
    const d = declarationOf(e.name as string, ancestors);
    return !!d && (d.optional || nullable(d.type, program));
  }
  if (e.type === 'MemberExpression' && !e.computed) {
    const prop = nameOf(e.property as Node);
    if (!prop) return false;
    const decls = propertyDeclarations(prop, program);
    return decls.length > 0 && decls.every((d) => d.optional === true || nullable(ann(d), program));
  }
  if (e.type === 'CallExpression') {
    const callee = e.callee as Node;
    const method = callee.type === 'MemberExpression' && !callee.computed ? nameOf(callee.property as Node) : undefined;
    return method !== undefined && NULLISH_METHODS.has(method);
  }
  return false;
}
/** Built-in methods whose result type includes `undefined` or `null`. */
const NULLISH_METHODS = new Set(['get', 'find', 'findLast', 'pop', 'shift', 'match', 'exec', 'at', 'querySelector', 'getAttribute']);

/**
 * `OptionalChaining`: removing `?.` where the receiver is visibly nullable (a parameter or
 * variable declared nullable or optional, a property declared optional or nullable in every
 * same-file declaration of that name, a `Map#get`-like call) (TS18047/TS18048/TS2532).
 */
export const nullableReceiverRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'OptionalChaining') return undefined;
  const receiver = (node.type === 'CallExpression' ? ((node.callee as Node).type === 'MemberExpression' ? node.callee : undefined) : node) as Node | undefined;
  if (node.type === 'CallExpression') {
    // `f?.()` checks the callee itself.
    const callee = node.callee as Node;
    return visiblyNullish(callee.type === 'ChainExpression' ? (callee.expression as Node) : callee, ancestors) ? 'type-invalid: the callee may be undefined' : undefined;
  }
  const obj = receiver?.object as Node | undefined;
  if (!obj) return undefined;
  // `a?.b?.c`: the inner optional chain short-circuits the whole chain, so its nullishness does not count.
  if (obj.type === 'ChainExpression' || (obj.type === 'MemberExpression' && obj.optional)) return undefined;
  return visiblyNullish(obj, ancestors) ? 'type-invalid: the receiver may be null or undefined' : undefined;
};

/**
 * `LogicalOperator` `a ?? b` → `a && b` where `a` is visibly nullable and the expression is
 * returned or assigned where the declared type visibly excludes null and undefined.
 */
export const nullishToAndRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'LogicalOperator' || node.operator !== '??') return undefined;
  const t = targetType(node, ancestors);
  if (!t || !visiblyNonNullable(t, programOf(ancestors))) return undefined;
  return visiblyNullish(node.left as Node, ancestors) ? 'type-invalid: `&&` keeps the nullish value' : undefined;
};

/** The same, without the check on the left operand: kept for measurement only. */
export const nullishToAndLooseRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'LogicalOperator' || node.operator !== '??') return undefined;
  const t = targetType(node, ancestors);
  return t && visiblyNonNullable(t, programOf(ancestors)) ? 'type-invalid: `&&` keeps the nullish value' : undefined;
};

const NON_BOOLEAN = new Set(['TSStringKeyword', 'TSNumberKeyword', 'TSBigIntKeyword', 'TSSymbolKeyword', 'TSArrayType', 'TSTupleType', 'TSTypeLiteral', 'TSNullKeyword', 'TSUndefinedKeyword', 'TSInterfaceDeclaration']);

/**
 * `ConditionalExpression` → `true`/`false` on a logical expression that is returned or assigned
 * where the declared type visibly excludes booleans (TS2322).
 */
export const booleanInValuePositionRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'ConditionalExpression' || node.type !== 'LogicalExpression') return undefined;
  const t = targetType(node, ancestors);
  if (!t) return undefined;
  const ms = members(t, programOf(ancestors));
  const ok = ms.length > 0 && ms.every((m) => NON_BOOLEAN.has(m.type) || (m.type === 'TSLiteralType' && typeof (m.literal as Node).value !== 'boolean'));
  return ok ? 'type-invalid: a boolean where the declared type has none' : undefined;
};

/**
 * `ArrayDeclaration` `[a, b]` → `[]` initialising an unannotated variable: the binding's type
 * becomes an evolving `any[]` or `never[]`, and its uses stop compiling (TS7005/TS7034/TS2345).
 */
export const untypedArrayRule: MutantFilter = ({ mutatorName, node, ancestors }) => {
  if (mutatorName !== 'ArrayDeclaration' || node.type !== 'ArrayExpression' || (node.elements as unknown[]).length === 0) return undefined;
  const decl = ancestors[ancestors.length - 1];
  if (!decl || decl.type !== 'VariableDeclarator' || decl.init !== node || ann(decl.id as Node) || !nameOf(decl.id as Node)) return undefined;
  return 'type-invalid: the variable loses its element type';
};

export interface TypeRule {
  name: string;
  filter: MutantFilter;
  mutator: string;
  /** Shipped (on by default under `strict`) only when measured at 100% precision. */
  shipped: boolean;
}

export const TYPE_RULES: readonly TypeRule[] = [
  { name: 'type:returning-body', filter: returningBodyRule, mutator: 'BlockStatement', shipped: true },
  { name: 'type:required-properties', filter: requiredPropertiesRule, mutator: 'ObjectLiteral', shipped: true },
  { name: 'type:used-keys', filter: usedKeysRule, mutator: 'ObjectLiteral', shipped: true },
  { name: 'type:called-arrow', filter: calledArrowRule, mutator: 'ArrowFunction', shipped: true },
  { name: 'type:nullable-receiver', filter: nullableReceiverRule, mutator: 'OptionalChaining', shipped: true },
  { name: 'type:nullish-to-and', filter: nullishToAndRule, mutator: 'LogicalOperator', shipped: true },
  { name: 'type:boolean-in-value-position', filter: booleanInValuePositionRule, mutator: 'ConditionalExpression', shipped: true },
  { name: 'type:untyped-array', filter: untypedArrayRule, mutator: 'ArrayDeclaration', shipped: false },
  { name: 'type:declared-return-arrow', filter: declaredReturnArrowRule, mutator: 'ArrowFunction', shipped: false },
  { name: 'type:nullish-to-and-loose', filter: nullishToAndLooseRule, mutator: 'LogicalOperator', shipped: false },
];

/** Filters for `@tzap/instrument`: the shipped rules by default, or the named ones. Only for `strict` projects. */
export function typeFilters(enabled: readonly string[] = TYPE_RULES.filter((r) => r.shipped).map((r) => r.name)): Array<{ name: string; filter: MutantFilter }> {
  return TYPE_RULES.filter((r) => enabled.includes(r.name)).map((r) => ({ name: r.name, filter: r.filter }));
}
