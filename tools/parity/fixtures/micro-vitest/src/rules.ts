// A static mutant that makes the module throw while it loads: emptying make()'s body leaves
// RULES[0] undefined, so reading `.name` at load time throws and every test file importing this
// module fails to load. The hand-written expectation is Killed (the suite fails).
function make(name: string): { name: string } {
  return { name };
}
export const RULES = [make('first')];
export const FIRST = RULES[0].name;
