// Enforces the package graph in docs/architecture.md against the imports actually written,
// not against package.json, so the shape cannot drift one hurried import at a time.
//
// - @tzap/model, @tzap/runtime and @tzap/protocol import no third-party package.
// - @tzap/runtime imports nothing at all, not even Node built-ins: it runs inside the user's
//   module graph, possibly in a DOM-like environment.
// - @tzap/core knows the runner SPI, never a concrete runner, and never git or reporting.
// - nothing imports the CLI.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const RULES = {
  model: { allow: [] },
  runtime: { allow: [], noBuiltins: true },
  protocol: { allow: ['@tzap/model'] },
  instrument: { allow: ['@tzap/model', '@tzap/runtime', 'oxc-parser', 'oxc-minify', 'oxc-transform', 'magic-string', 'weapon-regex'] },
  core: { allow: ['@tzap/model', '@tzap/protocol', '@tzap/instrument', 'tinyglobby', 'oxc-parser'] },
  git: { allow: ['@tzap/model'] },
  report: { allow: ['@tzap/model', 'mutation-testing-elements'] },
  discover: { allow: ['@tzap/model', 'tinyglobby', 'yaml'] },
  'runner-vitest': { allow: ['@tzap/model', '@tzap/protocol', '@tzap/runtime'] },
  'runner-node': { allow: ['@tzap/model', '@tzap/protocol', '@tzap/runtime'] },
  'runner-jest': { allow: ['@tzap/model', '@tzap/protocol', '@tzap/runtime'] },
  'runner-mocha': { allow: ['@tzap/model', '@tzap/protocol', '@tzap/runtime'] },
  typecheck: { allow: ['@tzap/model', '@tzap/instrument', '@tzap/protocol'] },
};

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(c|m)?[jt]s$/.test(f) ? [p] : [];
  });

// `import ... from`, `import()`, a bare `import '...'`, and the CommonJS forms: `import x = require()`, `require()`.
const IMPORT = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

const problems = [];
for (const pkg of readdirSync(packagesDir)) {
  const src = path.join(packagesDir, pkg, 'src');
  let files;
  try {
    files = walk(src);
  } catch {
    continue;
  }
  const rule = RULES[pkg];
  // The CLI is the composition root, allowed everything; every other package needs a rule.
  if (!rule && pkg !== 'tzap') problems.push(`packages/${pkg}: no boundary rule; add one to scripts/check-boundaries.mjs`);
  for (const file of files) {
    // Template literals hold generated code (the Vitest setup shim), not imports of this package.
    const text = readFileSync(file, 'utf8').replace(/`(?:\\.|[^`\\])*`/g, '``');
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!spec || spec.startsWith('.')) continue;
      const rel = path.relative(root, file);
      if (spec === 'tzap' || spec.startsWith('tzap/')) problems.push(`${rel}: imports the CLI (${spec})`);
      if (!rule) continue;
      if (spec.startsWith('node:')) {
        if (rule.noBuiltins) problems.push(`${rel}: imports ${spec}, but @tzap/${pkg} must import nothing`);
        continue;
      }
      const name = packageName(spec);
      if (!rule.allow.includes(name)) problems.push(`${rel}: imports ${name}, which @tzap/${pkg} may not (allowed: ${rule.allow.join(', ') || 'nothing'})`);
    }
  }
}

if (problems.length) {
  console.error(`package boundaries violated:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('package boundaries hold');
