// Builds the one package tzap publishes: `tzap`, with every internal @tzap/* package bundled in
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

// Entry points: the CLI, and each runner's host and worker files, which are started or imported
// by path at run time and so must stay separate files next to the CLI.
const entryPoints = { bin: path.join(root, 'packages/tzap/dist/bin.js'), cli: path.join(root, 'packages/tzap/dist/cli.js') };
for (const d of internal.filter((x) => x.startsWith('runner-'))) {
  for (const f of readdirSync(path.join(root, 'packages', d, 'dist'))) {
    if (!f.endsWith('.js') || f === 'index.js') continue;
    const name = f.slice(0, -3);
    // Every runner puts its host and worker files next to the CLI; names must not collide.
    const key = name === 'host' || name === 'worker-setup' || name === 'setup' ? `${d.slice('runner-'.length)}-${name}` : name;
    entryPoints[key] = path.join(root, 'packages', d, 'dist', f);
  }
}

// Runners locate their host and worker files by name next to themselves; after bundling that is
// the CLI's directory, under the prefixed names above.
const renames = {};
for (const key of Object.keys(entryPoints)) {
  const m = /^(\w+)-(host|worker-setup|setup)$/.exec(key);
  if (m) renames[`${m[1]}:${m[2]}.js`] = `${key}.js`;
}

const aliasInternal = {
  name: 'tzap-internal',
  setup(b) {
    b.onResolve({ filter: /^@tzap\// }, (args) => {
      const dir = args.path.slice('@tzap/'.length);
      return { path: path.join(root, 'packages', dir, 'dist', 'index.js') };
    });
    // `path.join(import.meta.dirname, 'host.js')` inside a runner means that runner's host.
    b.onLoad({ filter: /packages[\\/]runner-[\w-]+[\\/]dist[\\/]index\.js$/ }, (args) => {
      const runner = /runner-([\w-]+)/.exec(args.path)[1];
      let text = readFileSync(args.path, 'utf8');
      for (const [from, to] of Object.entries(renames)) {
        const [r, file] = from.split(':');
        if (r === runner) text = text.split(`'${file}'`).join(`'${to}'`);
      }
      return { contents: text, loader: 'js', resolveDir: path.dirname(args.path) };
    });
    b.onLoad({ filter: /packages[\\/]runner-[\w-]+[\\/]dist[\\/]host\.js$/ }, (args) => {
      const runner = /runner-([\w-]+)/.exec(args.path)[1];
      let text = readFileSync(args.path, 'utf8');
      for (const [from, to] of Object.entries(renames)) {
        const [r, file] = from.split(':');
        if (r === runner) text = text.split(`'${file}'`).join(`'${to}'`);
      }
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

const cli = manifests.tzap;
const pkg = {
  name: 'tzap',
  version: cli.version,
  description: cli.description,
  license: cli.license,
  type: 'module',
  bin: { tzap: './dist/bin.js' },
  exports: { '.': './dist/cli.js' },
  files: ['dist', 'README.md', 'LICENSE'],
  engines: cli.engines,
  repository: { type: 'git', url: 'git+https://github.com/huyz0/tzap.git' },
  keywords: ['mutation testing', 'testing', 'typescript', 'vitest', 'jest', 'stryker'],
  dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1))),
};
writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
for (const f of ['README.md', 'LICENSE']) if (existsSync(path.join(root, f))) cpSync(path.join(root, f), path.join(out, f));
const bin = path.join(out, 'dist', 'bin.js');
const text = readFileSync(bin, 'utf8');
if (!text.startsWith('#!')) writeFileSync(bin, `#!/usr/bin/env node\n${text}`);
console.log(`bundled ${Object.keys(entryPoints).length} entry points into ${path.relative(root, out)}; dependencies: ${Object.keys(dependencies).join(', ')}`);
