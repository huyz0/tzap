// A3: a mutant whose only effect is an uncaught exception thrown from a timer while the test is
// running. Every test still passes, but Vitest reports the uncaught exception and the run fails
// (exit 1): the mutant is detected. Hand-written expectation: Killed or RuntimeError, never
// Survived. (Mirrors remeda debounce.ts, where removing clearTimeout() makes a stale timer throw.)
let armed = true;

export function disarm(): void {
  armed = false;
}

export function fire(): number {
  setTimeout(() => {
    if (!armed) throw new Error('fired after disarm');
  }, 0);
  return 1;
}
