/**
 * The `compilerOptions.paths` of the project's tsconfigs, for the import graph: an import through a
 * path alias reaches the file it names. Read without TypeScript: JSON with comments and trailing
 * commas, following `extends` to relative files.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectModel } from '@tzap/model';

/** JSON with comments and trailing commas, as tsconfig allows, to plain JSON. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface CompilerPaths {
  /** Pattern -> targets, relative to `base`. */
  paths?: Record<string, string[]>;
  /** The directory the targets are relative to: baseUrl, or the tsconfig that declared paths. */
  base?: string;
}

function read(file: string, seen: Set<string>): CompilerPaths {
  if (seen.has(file) || !existsSync(file)) return {};
  seen.add(file);
  let json: { extends?: string | string[]; compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } };
  try {
    json = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
  const dir = path.dirname(file);
  // Only relative extends: a package's tsconfig (`@tsconfig/node22`) declares no project paths.
  let inherited: CompilerPaths = {};
  for (const e of [json.extends ?? []].flat()) {
    if (!e.startsWith('.')) continue;
    const target = path.resolve(dir, e.endsWith('.json') ? e : `${e}.json`);
    const r = read(target, seen);
    if (r.paths) inherited = r;
  }
  const o = json.compilerOptions ?? {};
  const baseUrl = o.baseUrl !== undefined ? path.resolve(dir, o.baseUrl) : undefined;
  if (o.paths) return { paths: o.paths, base: baseUrl ?? dir };
  if (inherited.paths && baseUrl) return { paths: inherited.paths, base: baseUrl };
  return inherited;
}

/** Every path alias of every package's tsconfig, as the import graph takes them: pattern -> absolute targets. */
export function tsconfigPaths(model: ProjectModel): Map<string, string[]> {
  const root = path.resolve(model.root);
  const out = new Map<string, string[]>();
  const files = new Set(model.packages.map((p) => (p.tsconfig ? path.resolve(root, p.tsconfig) : path.join(root, p.root, 'tsconfig.json'))));
  files.add(path.join(root, 'tsconfig.json'));
  for (const f of files) {
    const { paths, base } = read(f, new Set());
    if (!paths || !base) continue;
    for (const [pattern, targets] of Object.entries(paths)) {
      const list = out.get(pattern) ?? [];
      for (const t of targets) list.push(path.resolve(base, t));
      out.set(pattern, [...new Set(list)]);
    }
  }
  return out;
}
