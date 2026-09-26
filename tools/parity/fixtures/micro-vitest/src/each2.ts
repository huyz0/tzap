// Same shape as superjson's transformer.ts:95: a forEach statement inside an arrow function
// that is itself an array element. Its callback's BlockStatement mutant is in the subtree.
export const handlers = [
  (v: Error, props: string[]) => {
    const base: Record<string, unknown> = { name: v.name };
    props.forEach((prop) => {
      base[prop] = (v as any)[prop];
    });
    return base;
  },
];
