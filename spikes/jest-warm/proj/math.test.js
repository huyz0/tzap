const { add } = require('./math');
let before = 0, after = 0;
beforeEach(() => { before++; });
afterEach(() => { after++; });
test('adds', () => { expect(add(2, 3)).toBe(5); });
test('other', () => { expect(1).toBe(1); });
afterAll(() => { globalThis.__hookCounts = { before, after, evals: globalThis.__evals }; });
