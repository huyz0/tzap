import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MODEL_SCHEMA_VERSION } from '@tzap/model';
import { ImportGraph } from '../src/graph.js';
import { stripJsonc, tsconfigPaths } from '../src/tsconfig.js';

const root = mkdtempSync(path.join(tmpdir(), 'tzap-tsconfig-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

describe('stripJsonc', () => {
  it('drops comments and trailing commas, and keeps comment-like text inside strings', () => {
    const text = '{\n  // a comment\n  "$schema": "https://example.com/x", /* block */\n  "a": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ $schema: 'https://example.com/x', a: [1, 2] });
  });
});

describe('tsconfigPaths', () => {
  it('reads paths relative to baseUrl, through a relative extends, for each package', () => {
    write('tsconfig.base.json', '{ "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["shared/*"] } } }');
    write('app/tsconfig.json', '{ "extends": "../tsconfig.base.json", // inherits\n "compilerOptions": { "strict": true, } }');
    write('web/tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');
    const paths = tsconfigPaths({
      schemaVersion: MODEL_SCHEMA_VERSION,
      root,
      packages: [
        { id: 'app', root: 'app', sources: [] },
        { id: 'web', root: 'web', sources: [] },
      ],
    });
    expect(Object.fromEntries(paths)).toEqual({ '@shared/*': [path.join(root, 'shared/*')], '@/*': [path.join(root, 'web/src/*')] });
  });
});

describe('the import graph with aliases', () => {
  it('follows a path alias to the file it names', () => {
    write('web/src/lib/math.ts', 'export const add = (a: number, b: number) => a + b;\n');
    write('web/test/math.test.ts', "import { add } from '@/lib/math';\n");
    const graph = new ImportGraph({ root, paths: new Map([['@/*', [path.join(root, 'web/src/*')]]]) });
    const c = graph.closure(path.join(root, 'web/test/math.test.ts'));
    expect(c.files).toContain(path.join(root, 'web/src/lib/math.ts'));
    expect(c.dynamic).toBe(false);
  });

  it('cannot see where an import nothing resolves goes (a bundler alias), so its reach is everything', () => {
    write('web/test/aliased.test.ts', "import { add } from '~/lib/math';\nimport fs from 'node:fs';\nimport path from 'path';\n");
    expect(new ImportGraph({ root }).closure(path.join(root, 'web/test/aliased.test.ts')).dynamic).toBe(true);
    write('web/test/plain.test.ts', "import fs from 'node:fs';\nimport path from 'path';\n");
    expect(new ImportGraph({ root }).closure(path.join(root, 'web/test/plain.test.ts')).dynamic).toBe(false);
  });
});
