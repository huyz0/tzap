import { skipTrivia, type LineIndex } from './text.js';

/**
 * `// Stryker disable ...` and `// Stryker restore ...` comments, with Stryker's syntax and
 * semantics, so a project moving from Stryker keeps its annotations. `tzap` works in place of
 * `Stryker` too.
 *
 *   // Stryker disable next-line StringLiteral,ObjectLiteral: logging only
 *   // tzap disable all
 *   // tzap restore all
 */
const DIRECTIVE = /^\s?(?:Stryker|tzap) (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/;
const DEFAULT_REASON = 'Ignored using a comment';

interface Directive {
  offset: number;
  disable: boolean;
  line: number | undefined;
  mutators: string[];
  reason: string;
}

export class Directives {
  private readonly directives: Directive[] = [];

  constructor(comments: ReadonlyArray<{ type: string; value: string; start: number; end: number }>, source: string, lines: LineIndex) {
    for (const c of comments) {
      const m = DIRECTIVE.exec(c.value);
      if (!m) continue;
      const [, kind, scope, mutators, reason] = m;
      // A next-line directive applies to the line of the code that follows the comment.
      const line = scope === 'next-line' ? lines.line(skipTrivia(source, c.end)) : undefined;
      this.directives.push({
        offset: c.start,
        disable: kind === 'disable',
        line,
        mutators: mutators!.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
        reason: (reason ?? DEFAULT_REASON).trim(),
      });
    }
  }

  /** The reason a mutant starting at `offset` on `line` is ignored, or undefined. The latest matching directive wins. */
  ignoreReason(offset: number, line: number, mutatorName: string): string | undefined {
    const name = mutatorName.toLowerCase();
    for (let i = this.directives.length - 1; i >= 0; i--) {
      const d = this.directives[i]!;
      if (d.offset > offset) continue;
      if (d.line !== undefined && d.line !== line) continue;
      if (!d.mutators.includes('all') && !d.mutators.includes(name)) continue;
      return d.disable ? d.reason : undefined;
    }
    return undefined;
  }

}
