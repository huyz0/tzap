import { describe, expect, it } from 'vitest';
import { Account36, Stack36 } from '../src/model36';

describe("model36", () => {
  it("Account36 #0", () => {
    expect((() => { const a = new Account36(); a.deposit(131); return a.withdraw(132); })()).toBe(false);
  });

  it("Stack36 #1", () => {
    expect(new Stack36<number>().push(5).push(14).peek()).toBeGreaterThan(0);
  });

  it("Account36 #2", () => {
    expect((() => { const a = new Account36(); a.deposit(131); a.withdraw(34); return a.total; })()).toBe(97);
  });

  it("Stack36 #3", () => {
    expect(typeof (() => { const s = new Stack36<number>().push(1).push(2); s.pop(); return s.peek(); })()).toBe("number");
  });

  it("Account36 #4", () => {
    expect((() => { const a = new Account36(); a.deposit(481); return a.withdraw(432); })()).toBe(false);
  });
});
