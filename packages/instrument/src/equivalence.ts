/**
 * Trivial compiler equivalence (Papadakis et al., ICSE'15) for JavaScript: two programs that a
 * minifier compiles to the same output are the same program, so a mutant whose file minifies to
 * the original's cannot be killed, and two mutants that minify alike are one mutant.
 *
 * TypeScript is transformed to JavaScript first; comments, formatting and dead code fall away,
 * and the minifier's constant folding catches `x * 1`-style equivalents. Names are not mangled,
 * so nothing is merged that merely looks alike after renaming.
 */
import { minifySync } from 'oxc-minify';
import { transformSync } from 'oxc-transform';

export function compiledForm(file: string): (text: string) => string | undefined {
  const isTs = /\.(m|c)?tsx?$/.test(file) || /\.(vue|svelte)$/.test(file);
  const jsName = file.replace(/\.(m|c)?tsx?$/, '.js').replace(/\.(vue|svelte)$/, '.js');
  return (text) => {
    try {
      const js = isTs ? transformSync(file.replace(/\.(vue|svelte)$/, '.ts'), text, { sourcemap: false }).code : text;
      const out = minifySync(jsName, js, { mangle: false, compress: true, sourcemap: false });
      return out.errors?.length ? undefined : out.code;
    } catch {
      return undefined;
    }
  };
}
