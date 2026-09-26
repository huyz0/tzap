# Versioning

tzap follows semantic versioning for everything a user or a tool depends on. What counts as a
breaking change for each surface:

| Surface | Breaking change | Handling |
|---|---|---|
| CLI flags and exit codes | removing or renaming a flag; changing an exit code's meaning | major |
| Project model (`schemaVersion`) | a field whose meaning changes, or a new required field | new schema major; an older tzap refuses a newer model with advice |
| Native JSON report (`schemaVersion`) | removing or renaming a field | major; new fields are minor |
| mutation-testing-elements output | none of tzap's own: it follows the published schema | — |
| Mutator names | renaming a mutator | major: names key caches and the StrykerJS comparison |
| Mutant ids | any change to how an id is computed | minor, and the cache is invalidated by the tzap version it records |
| Cache format | any change | not breaking: the cache records the tzap version that wrote it and ignores itself under another |
| Runner SPI (`@tzap/protocol`) | any change | internal; runners ship inside the `@huyz0/tzap` package |

## Fixes that change verdicts

A fix that corrects a wrong verdict changes scores. It is released as a patch, and its release
notes say which verdicts move and why. A score that goes down after upgrading is usually tzap
telling the truth for the first time; the notes say so when it is.

## Supported versions of other tools

Adding support for a runner, Node or TypeScript version is minor. Dropping one is major, except
for versions their own maintainers no longer support, which may be dropped in a minor with a
release note.
