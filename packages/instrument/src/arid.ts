/**
 * Arid-node rules, after Google's "State of Mutation Testing at Google" (ICSE-SEIP'18): code
 * whose mutants no reviewer would write a test for. Logging is the rule Google found right on
 * 99 of 100 sampled cases, and the most-discussed source of noise in Stryker (#1472), so it is
 * on by default. Rules are data: a rule is a pattern on the callee of the enclosing call.
 */
import type { Node } from './ast.js';
import type { MutantFilter } from './instrument.js';

export interface AridRule {
  name: string;
  /** Matched against the callee's source text with whitespace removed, e.g. `console.log`. */
  callee: RegExp;
  reason: string;
  /** On unless disabled; off-by-default rules are opt-in until their detection loss is measured. */
  defaultOn: boolean;
}

export const ARID_RULES: readonly AridRule[] = [
  {
    name: 'console',
    callee: /^console\.(log|info|warn|error|debug|trace|dir|table|group|groupEnd|groupCollapsed|time|timeEnd|count)$/,
    reason: 'arid: console output',
    defaultOn: true,
  },
  {
    name: 'logger',
    callee: /^(this\.)?#?_?(log|logger|LOG|LOGGER|log4js|winston|pino)\.(trace|debug|info|warn|warning|error|fatal|log|verbose|silly)$/,
    reason: 'arid: logging',
    defaultOn: true,
  },
  {
    name: 'debug',
    callee: /^(this\.)?#?_?debug$/,
    reason: 'arid: debug output',
    defaultOn: true,
  },
];

const BOUNDARY = (n: Node) =>
  n.type.endsWith('Statement') && n.type !== 'ExpressionStatement'
    ? true
    : n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'Program';

function calleeText(source: string, call: Node): string | undefined {
  const callee = call.callee as Node | undefined;
  if (!callee) return undefined;
  return source.slice(callee.start, callee.end).replace(/\s+/g, '').replace(/\?\./g, '.');
}

/** Filters for the enabled rules: a mutant inside the arguments of, or removing, a matching call is dropped. */
export function aridFilters(enabled: readonly string[] = ARID_RULES.filter((r) => r.defaultOn).map((r) => r.name)): Array<{ name: string; filter: MutantFilter }> {
  const rules = ARID_RULES.filter((r) => enabled.includes(r.name));
  if (rules.length === 0) return [];
  const filter: MutantFilter = ({ node, ancestors, source }) => {
    const chain = [...ancestors, node];
    for (let i = chain.length - 1; i >= 0; i--) {
      const n = chain[i]!;
      let call: Node | undefined;
      if (n.type === 'CallExpression') call = n;
      else if (n.type === 'ExpressionStatement' && (n.expression as Node).type === 'CallExpression') call = n.expression as Node;
      if (call) {
        const text = calleeText(source, call);
        const hit = text !== undefined ? rules.find((r) => r.callee.test(text)) : undefined;
        // The callee itself is not an argument: `log(x).then(...)` mutated in `then` is not arid.
        if (hit && (n === node || (call.arguments as Node[]).some((a) => a.start <= node.start && node.end <= a.end) || n.type === 'ExpressionStatement')) {
          return hit.reason;
        }
      }
      if (i < chain.length - 1 && BOUNDARY(n)) break;
    }
    return undefined;
  };
  return [{ name: 'arid', filter }];
}
