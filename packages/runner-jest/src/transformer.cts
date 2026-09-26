/**
 * The tzap transformer. The host wraps every entry of the project's resolved `transform` in it:
 * for an instrumented file it substitutes the instrumented source, then hands that to the
 * project's own transformer (babel-jest, ts-jest, @swc/jest, ...) so TypeScript and JSX are still
 * compiled exactly as the suite compiles them. Other files pass straight through to the delegate.
 *
 * The cache key of an instrumented file is the delegate's key over the instrumented source, under
 * a tzap prefix: Jest's transform cache can never serve the uninstrumented output for it, or an
 * instrumented output for a different instrumentation.
 */
import crypto = require('node:crypto');
import fs = require('node:fs');

const { createHash } = crypto;
const { readFileSync } = fs;

interface Config {
  delegate: string;
  delegateOptions?: unknown;
  instrumented: string;
}

interface Options {
  transformerConfig?: unknown;
  configString?: string;
  [k: string]: unknown;
}

type Result = string | { code: string; map?: unknown };

interface Transformer {
  canInstrument?: boolean;
  getCacheKey?(source: string, file: string, options: Options): string;
  getCacheKeyAsync?(source: string, file: string, options: Options): Promise<string>;
  process?(source: string, file: string, options: Options): Result;
  processAsync?(source: string, file: string, options: Options): Promise<Result>;
  createTransformer?(config?: unknown): Transformer | Promise<Transformer>;
}

const norm = (p: string) => {
  const s = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

const maps = new Map<string, Map<string, string>>();

function instrumentedFiles(file: string): Map<string, string> {
  let m = maps.get(file);
  if (!m) {
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { code: string }>;
    m = new Map(Object.entries(json).map(([k, v]) => [norm(k), v.code]));
    maps.set(file, m);
  }
  return m;
}

function load(p: string): Transformer {
  // As Jest loads transformers: interop default for an ES module.
  const mod = require(p) as Transformer & { __esModule?: boolean; default?: Transformer };
  return mod && mod.__esModule ? mod.default! : mod;
}

async function createTransformer(config: Config): Promise<Transformer> {
  let delegate = load(config.delegate);
  if (typeof delegate.createTransformer === 'function') delegate = await delegate.createTransformer(config.delegateOptions);
  const files = instrumentedFiles(config.instrumented);
  const opts = (o: Options): Options => ({ ...o, transformerConfig: config.delegateOptions });
  const swap = (source: string, file: string) => files.get(norm(file)) ?? source;
  const ownKey = (source: string, file: string, o: Options) =>
    createHash('sha256').update(source).update('\0').update(file).update('\0').update(o.configString ?? '').update('\0').update(config.delegate).update(JSON.stringify(config.delegateOptions ?? null)).digest('hex');
  const mark = (file: string, key: string) => (files.has(norm(file)) ? `tzap1:${key}` : key);

  const t: Transformer = { canInstrument: delegate.canInstrument === true };
  t.getCacheKey = (source, file, o) => {
    const code = swap(source, file);
    return mark(file, delegate.getCacheKey ? delegate.getCacheKey(code, file, opts(o)) : ownKey(code, file, o));
  };
  t.getCacheKeyAsync = async (source, file, o) => {
    const code = swap(source, file);
    if (delegate.getCacheKeyAsync) return mark(file, await delegate.getCacheKeyAsync(code, file, opts(o)));
    return t.getCacheKey!(source, file, o);
  };
  if (delegate.process) t.process = (source, file, o) => delegate.process!(swap(source, file), file, opts(o));
  if (delegate.processAsync || delegate.process) {
    t.processAsync = async (source, file, o) =>
      delegate.processAsync ? delegate.processAsync(swap(source, file), file, opts(o)) : delegate.process!(swap(source, file), file, opts(o));
  }
  return t;
}

export = { createTransformer };
