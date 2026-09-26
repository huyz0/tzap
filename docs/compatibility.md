# Compatibility

What tzap has been run against, not what it might work with. Anything not listed here is
untested; a result from it should be checked against `--engine reference` before being trusted.

## Runtime

| | Tested | Notes |
|---|---|---|
| Node | 22.22, 22.23, 24.21, 26.7 | `engines: >=22.12`. The node:test runner needs 22.15+ (`module.registerHooks`). Vitest, Jest and node:test fixtures give identical verdicts on all three |
| OS | Windows 11, Linux, macOS | Linux and macOS through the CI matrix (Node 22, 24, 26 on each) |
| Package managers | pnpm 11, npm 11 | yarn workspaces are discovered but not run end to end |

## Test runners

| Runner | Version | Status |
|---|---|---|
| Vitest | 5.0.2 | supported: `isolate` either way, threads and forks pools, `test.projects` at the root |
| Vitest | 4.1.x | runs (used for the StrykerJS comparison); not in the CI matrix |
| Jest | 30.5, 29.7 | supported, in band. On 29, `test.concurrent` tests run one at a time (as on 30), with their `beforeEach`/`afterEach` around them |
| node:test | Node 22.15+ | supported; TypeScript tests through Node's own type stripping only |
| Mocha | — | in progress |
| Bun, Deno | — | not supported; see [spikes/C-bun-deno.md](spikes/C-bun-deno.md) |
| Karma, Jasmine | — | not supported (Karma is deprecated; Angular 21 moved to Vitest) |

## Languages and frameworks

| | Status |
|---|---|
| TypeScript, JavaScript (ESM and CommonJS), `.mts`/`.cts` | supported; the source dialect is kept and the project's own pipeline transpiles it |
| JSX / TSX | supported (React Testing Library under jsdom tested) |
| Vue single-file components | `<script>` and `<script setup>` mutated; templates are not |
| Svelte 5 | `<script>` blocks mutated (runes tested); markup is not |
| Angular | component classes as ordinary TypeScript under Vitest; templates are not; untested |
| Astro | untested |
| Decorators | never mutated (they run once, at class definition) |

## Environments

jsdom and happy-dom through the runner's own configuration; jsdom tested with React, Vue and
Svelte fixtures. Browser mode (Vitest `browser`) is untested.

## Type checking

`--typecheck` uses the project's own `typescript`: see [status.md](status.md).

## What would change these

A runner or framework moves from untested to supported when it has a fixture here whose warm and
reference verdicts agree mutant for mutant, and a CI job on the supported version range.
