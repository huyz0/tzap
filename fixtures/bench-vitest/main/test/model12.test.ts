import { describe, expect, it } from 'vitest';
import { Stack12 } from '../src/model12';

describe("model12", () => {
  it("Stack12 #0", () => {
    expect(new Stack12<number>().isEmpty()).toBe(true);
  });

  it("Stack12 #1", () => {
    expect(new Stack12<number>().push(1).push(10).peek()).toBe(10);
  });

  it("Stack12 #2", () => {
    expect(new Stack12<string>().push('a').push('b').size).toBe(2);
  });

  it("Stack12 #3", () => {
    expect((() => { const s = new Stack12<number>().push(1).push(2); s.pop(); return s.peek(); })()).toBe(1);
  });

  it("Stack12 #4", () => {
    expect(typeof new Stack12<number>().isEmpty()).toBe("boolean");
  });
});
