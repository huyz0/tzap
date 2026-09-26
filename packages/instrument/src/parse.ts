import { parseSync } from 'oxc-parser';
import type { Node } from './ast.js';

export interface Parsed {
  program: Node | undefined;
  comments: Array<{ type: string; value: string; start: number; end: number }>;
  errors: string[];
}

/** Dialect from the file name, as oxc expects it. */
export function langOf(file: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'tsx') return 'tsx';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'ts';
  if (ext === 'jsx') return 'jsx';
  // Plain .js files frequently contain JSX in React projects; oxc's jsx mode accepts both.
  return 'jsx';
}

/**
 * The single parse entry point. oxc-parser with parentheses dropped from the AST (Babel's
 * default shape, which Stryker's mutator rules assume) and UTF-16 offsets.
 */
export function parse(file: string, source: string): Parsed {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const sourceType = ext === 'cjs' || ext === 'cts' ? 'script' : 'module';
  const r = parseSync(file, source, {
    lang: langOf(file),
    sourceType,
    preserveParens: false,
  });
  const errors = r.errors.filter((e) => e.severity !== 'Warning').map((e) => e.message);
  return {
    program: r.program as unknown as Node,
    comments: r.comments as Parsed['comments'],
    errors,
  };
}
