import { describe, expect, it } from 'vitest';
import { Account28, Stack28 } from '../src/model28';

describe("model28", () => {
  it("Account28 #0", () => {
    expect(typeof (() => { const a = new Account28(); a.deposit(93); a.withdraw(38); return a.total; })()).toBe("number");
  });

  it("Stack28 #1", () => {
    expect(new Stack28<string>().push('a').push('b').size).toBe(2);
  });

  it("Account28 #2", () => {
    expect(typeof (() => { const a = new Account28(); a.deposit(93); return a.withdraw(94); })()).toBe("boolean");
  });

  it("Stack28 #3", () => {
    expect((() => { const s = new Stack28<number>().push(1).push(2); s.pop(); return s.peek(); })()).toBe(1);
  });

  it("Account28 #4", () => {
    expect((() => { const a = new Account28(); return () => a.deposit(0); })()).toThrow("amount must be positive");
  });
});
