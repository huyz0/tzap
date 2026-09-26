import { MODEL_SCHEMA_VERSION, type ProjectModel } from './project-model.js';

/** A model that cannot be used. Every message names the field, the expected shape and the actual value. */
export class ModelValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid project model:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ModelValidationError';
  }
}

export interface ParsedModel {
  model: ProjectModel;
  /** Non-fatal findings, such as unknown fields, which are ignored for forward compatibility. */
  warnings: string[];
}

const RUNNER_KINDS = ['vitest', 'jest', 'node', 'mocha'];
const GRANULARITIES = ['line', 'function', 'file'];

const KNOWN = {
  model: ['$schema', 'schemaVersion', 'root', 'packages', 'scope', 'cache', 'reporters'],
  package: ['id', 'root', 'sources', 'exclude', 'tests', 'tsconfig', 'runner', 'env'],
  runner: ['kind', 'config', 'version'],
  scope: ['kind', 'from', 'to', 'patch', 'granularity'],
  cache: ['dir'],
};

function show(v: unknown): string {
  if (v === undefined) return 'nothing';
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates an already-parsed JSON value as a project model. */
export function validateModel(value: unknown): ParsedModel {
  const problems: string[] = [];
  const warnings: string[] = [];
  const unknownFields = (obj: Record<string, unknown>, known: string[], where: string) => {
    for (const k of Object.keys(obj)) {
      if (!known.includes(k)) warnings.push(`${where}.${k}: unknown field, ignored`);
    }
  };
  const str = (obj: Record<string, unknown>, k: string, where: string, required: boolean) => {
    const v = obj[k];
    if (v === undefined && !required) return;
    if (typeof v !== 'string' || v.length === 0) {
      problems.push(`${where}.${k}: expected a non-empty string, got ${show(v)}`);
    }
  };
  const strArray = (obj: Record<string, unknown>, k: string, where: string, required: boolean) => {
    const v = obj[k];
    if (v === undefined && !required) return;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      problems.push(`${where}.${k}: expected an array of strings, got ${show(v)}`);
    }
  };

  if (!isObject(value)) {
    throw new ModelValidationError([`model: expected a JSON object, got ${show(value)}`]);
  }
  const version = value.schemaVersion;
  if (typeof version !== 'number') {
    problems.push(`schemaVersion: expected ${MODEL_SCHEMA_VERSION}, got ${show(version)}`);
  } else if (Math.floor(version) !== MODEL_SCHEMA_VERSION) {
    // An unknown major is fatal: guessing at a newer model's meaning produces wrong answers.
    throw new ModelValidationError([
      `schemaVersion: this tzap reads model version ${MODEL_SCHEMA_VERSION}, the model is version ${version}. ` +
        (version > MODEL_SCHEMA_VERSION
          ? 'Upgrade tzap, or regenerate the model with this version of `tzap model`.'
          : 'Regenerate the model with `tzap model`.'),
    ]);
  }
  unknownFields(value, KNOWN.model, 'model');
  str(value, 'root', 'model', true);
  if (!Array.isArray(value.packages) || value.packages.length === 0) {
    problems.push(`packages: expected a non-empty array of packages, got ${show(value.packages)}`);
  } else {
    const ids = new Set<string>();
    value.packages.forEach((p: unknown, i: number) => {
      const where = `packages[${i}]`;
      if (!isObject(p)) {
        problems.push(`${where}: expected an object, got ${show(p)}`);
        return;
      }
      unknownFields(p, KNOWN.package, where);
      str(p, 'id', where, true);
      str(p, 'root', where, true);
      strArray(p, 'sources', where, true);
      strArray(p, 'exclude', where, false);
      strArray(p, 'tests', where, false);
      str(p, 'tsconfig', where, false);
      if (typeof p.id === 'string') {
        if (ids.has(p.id)) problems.push(`${where}.id: duplicate package id ${show(p.id)}`);
        ids.add(p.id);
      }
      if (p.runner !== undefined) {
        if (!isObject(p.runner)) {
          problems.push(`${where}.runner: expected an object, got ${show(p.runner)}`);
        } else {
          unknownFields(p.runner, KNOWN.runner, `${where}.runner`);
          if (!RUNNER_KINDS.includes(p.runner.kind as string)) {
            problems.push(`${where}.runner.kind: expected one of ${RUNNER_KINDS.join(', ')}, got ${show(p.runner.kind)}`);
          }
          str(p.runner, 'config', `${where}.runner`, false);
          str(p.runner, 'version', `${where}.runner`, false);
        }
      }
      if (p.env !== undefined) {
        if (!isObject(p.env) || Object.values(p.env).some((v) => typeof v !== 'string')) {
          problems.push(`${where}.env: expected an object of string values, got ${show(p.env)}`);
        }
      }
    });
  }
  if (value.scope !== undefined) {
    const s = value.scope;
    if (!isObject(s)) {
      problems.push(`scope: expected an object, got ${show(s)}`);
    } else {
      unknownFields(s, KNOWN.scope, 'scope');
      if (s.kind !== 'full' && s.kind !== 'diff') {
        problems.push(`scope.kind: expected "full" or "diff", got ${show(s.kind)}`);
      }
      str(s, 'from', 'scope', false);
      str(s, 'to', 'scope', false);
      str(s, 'patch', 'scope', false);
      if (s.granularity !== undefined && !GRANULARITIES.includes(s.granularity as string)) {
        problems.push(`scope.granularity: expected one of ${GRANULARITIES.join(', ')}, got ${show(s.granularity)}`);
      }
    }
  }
  if (value.cache !== undefined) {
    if (!isObject(value.cache)) problems.push(`cache: expected an object, got ${show(value.cache)}`);
    else {
      unknownFields(value.cache, KNOWN.cache, 'cache');
      str(value.cache, 'dir', 'cache', true);
    }
  }
  strArray(value, 'reporters', 'model', false);
  if (problems.length > 0) throw new ModelValidationError(problems);
  return { model: value as unknown as ProjectModel, warnings };
}

/** Parses model text. JSON syntax errors are reported as validation problems, with the position. */
export function parseModel(text: string): ParsedModel {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new ModelValidationError([`model: not valid JSON (${(e as Error).message})`]);
  }
  return validateModel(value);
}

/**
 * Serialises a model deterministically: two-space indentation, keys in declaration order,
 * trailing newline. `parse(serialise(m))` round-trips byte for byte.
 */
export function serialiseModel(model: ProjectModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}
