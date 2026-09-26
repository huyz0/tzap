globalThis.__evals = (globalThis.__evals ?? 0) + 1;
exports.add = (a, b) => (globalThis.__mutant === 1 ? a - b : a + b);
