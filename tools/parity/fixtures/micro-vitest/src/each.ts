// Stryker 10 documents CallExpression as "only if no other mutant is in the subtree". The
// forEach statement below contains the callback's BlockStatement mutant, so it must not get a
// CallExpression (`;`) mutant.
export function copyProps(src: Record<string, number>, dst: Record<string, number>, props: string[]): Record<string, number> {
  props.forEach((p) => {
    dst[p] = src[p];
  });
  return dst;
}
