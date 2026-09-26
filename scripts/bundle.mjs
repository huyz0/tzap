// Builds the one package tzap publishes: `@huyz0/tzap` (the unscoped `tzap` on npm is another
// project), whose command is `tzap`, with every internal @tzap/* package bundled in
// and every third-party dependency left as a real dependency. The internal packages exist to
// enforce boundaries in this repository, not to be installed one by one.
//
// Output: dist-npm/tzap/, ready for `npm pack` or `npm publish`.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist-npm', 'tzap');
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'dist'), { recursive: true });

const internal = readdirSync(path.join(root, 'packages')).filter((d) => existsSync(path.join(root, 'packages', d, 'package.json')));
const manifests = Object.fromEntries(internal.map((d) => [d, JSON.parse(readFileSync(path.join(root, 'packages', d, 'package.json'), 'utf8'))]));
const internalNames = new Set(Object.values(manifests).map((m) => m.name));

// Third-party runtime dependencies of everything bundled, at the versions the workspace uses.
const dependencies = {};
for (const m of Object.values(manifests)) {
  for (const [name, version] of Object.entries(m.dependencies ?? {})) {
    if (internalNames.has(name) || version.startsWith('workspace:')) continue;
    dependencies[name] = version;
  }
}

// Entry points: the CLI, and each runner's own files, which are started, imported or handed to
// the runner by path at run time and so must stay separate files next to the CLI. Each is
// prefixed with its runner's name so that two runners' host files cannot collide.
const entryPoints = { bin: path.join(root, 'packages/tzap/dist/bin.js'), cli: path.join(root, 'packages/tzap/dist/cli.js') };
const cjsEntryPoints = {};
const renames = {}; // runner -> { 'host.js': 'jest-host.js', ... }
for (const d of internal.filter((x) => x.startsWith('runner-'))) {
  const runner = d.slice('runner-'.length);
  renames[runner] = {};
  for (const f of readdirSync(path.join(root, 'packages', d, 'dist'))) {
    const m = /^(.+)\.(js|cjs)$/.exec(f);
    if (!m || f === 'index.js') continue;
    const [, name, ext] = m;
    if (ext === 'cjs' && name === 'shared') continue; // required by the others, bundled into them
    renames[runner][f] = `${runner}-${f}`;
    (ext === 'cjs' ? cjsEntryPoints : entryPoints)[`${runner}-${name}`] = path.join(root, 'packages', d, 'dist', f);
  }
}

const aliasInternal = {
  name: 'tzap-internal',
  setup(b) {
    b.onResolve({ filter: /^@tzap\// }, (args) => {
      const dir = args.path.slice('@tzap/'.length);
      return { path: path.join(root, 'packages', dir, 'dist', 'index.js') };
    });
    // A runner names its own files relative to itself; after bundling they sit next to the CLI
    // under prefixed names.
    b.onLoad({ filter: /packages[\\/]runner-[\w-]+[\\/]dist[\\/][\w-]+\.c?js$/ }, (args) => {
      const runner = /runner-([\w-]+)/.exec(args.path)[1];
      let text = readFileSync(args.path, 'utf8');
      for (const [from, to] of Object.entries(renames[runner] ?? {})) text = text.split(`'${from}'`).join(`'${to}'`);
      return { contents: text, loader: 'js', resolveDir: path.dirname(args.path) };
    });
  },
};

await build({
  entryPoints,
  outdir: path.join(out, 'dist'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: Object.keys(dependencies),
  plugins: [aliasInternal],
  banner: { js: "import { createRequire as __tzapCreateRequire } from 'node:module'; const require = __tzapCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});

if (Object.keys(cjsEntryPoints).length) {
  await build({
    entryPoints: cjsEntryPoints,
    outdir: path.join(out, 'dist'),
    outExtension: { '.js': '.cjs' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: Object.keys(dependencies),
    plugins: [aliasInternal],
    logLevel: 'warning',
  });
}

const cli = manifests.tzap;
const pkg = {
  name: '@huyz0/tzap',
  version: cli.version,
  description: cli.description,
  license: cli.license,
  type: 'module',
  bin: { tzap: 'dist/bin.js' },
  exports: { '.': './dist/cli.js' },
  files: ['dist', 'README.md', 'LICENSE'],
  engines: cli.engines,
  repository: { type: 'git', url: 'git+https://github.com/huyz0/tzap.git' },
  homepage: 'https://github.com/huyz0/tzap#readme',
  bugs: 'https://github.com/huyz0/tzap/issues',
  // A scoped package is private unless published public.
  publishConfig: { access: 'public' },
  keywords: ['mutation testing', 'testing', 'typescript', 'vitest', 'jest', 'stryker'],
  dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1))),
};
writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
for (const f of ['README.md', 'LICENSE']) if (existsSync(path.join(root, f))) cpSync(path.join(root, f), path.join(out, f));
const bin = path.join(out, 'dist', 'bin.js');
const text = readFileSync(bin, 'utf8');
if (!text.startsWith('#!')) writeFileSync(bin, `#!/usr/bin/env node\n${text}`);
console.log(`bundled ${Object.keys(entryPoints).length} entry points into ${path.relative(root, out)}; dependencies: ${Object.keys(dependencies).join(', ')}`);
