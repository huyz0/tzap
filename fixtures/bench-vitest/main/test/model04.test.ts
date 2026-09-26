import { describe, expect, it } from 'vitest';
import { Account04, Stack04 } from '../src/model04';

describe("model04", () => {
  it("Account04 #0", () => {
    expect((() => { const a = new Account04(); a.deposit(424); return a.withdraw(375); })()).toBe(false);
  });

  it("Stack04 #1", () => {
    expect(new Stack04<number>().push(9).push(10).peek()).toBe(10);
  });

  it("Account04 #2", () => {
    expect((() => { const a = new Account04(); a.deposit(165); a.deposit(40); return a.count(); })()).toBe(2);
  });

  it("Stack04 #3", () => {
    expect((() => { const s = new Stack04<number>().push(1).push(2); s.pop(); return s.peek(); })()).toBe(1);
  });

  it("Account04 #4", () => {
    expect((() => { const a = new Account04(); return () => a.deposit(0); })()).toThrow("amount must be positive");
  });
});
