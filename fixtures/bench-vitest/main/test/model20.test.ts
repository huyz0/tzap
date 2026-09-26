import { describe, expect, it } from 'vitest';
import { Account20 } from '../src/model20';

describe("model20", () => {
  it("Account20 #0", () => {
    expect((() => { const a = new Account20(); a.deposit(70); a.withdraw(16); return a.total; })()).toBe(54);
  });

  it("Account20 #1", () => {
    expect((() => { const a = new Account20(); return () => a.deposit(0); })()).toThrow("amount must be positive");
  });

  it("Account20 #2", () => {
    expect((() => { const a = new Account20(); a.deposit(70); return a.withdraw(71); })()).toBe(false);
  });

  it("Account20 #3", () => {
    expect((() => { const a = new Account20(); a.deposit(213); return a.withdraw(164); })()).toBe(false);
  });

  it("Account20 #4", () => {
    expect((() => { const a = new Account20(); a.deposit(70); a.deposit(16); return a.count(); })()).toBeGreaterThan(0);
  });
});
