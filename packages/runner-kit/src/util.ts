/** Small helpers every runner adapter needs, in one place so they cannot drift apart. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normPath } from '@tzap/protocol';

/** A URL without its query and hash: `file:///a.ts?tzap=3` is `file:///a.ts`. */
export function cleanUrl(u: string): string {
  const q = u.search(/[?#]/);
  return q === -1 ? u : u.slice(0, q);
}

/** The normalised path of a `file:` URL, or undefined for any other URL. */
export function urlToNorm(u: string): string | undefined {
  try {
    return normPath(fileURLToPath(cleanUrl(u)));
  } catch {
    return undefined;
  }
}

/**
 * The path Node's resolver reports for a file: symlinks resolved (macOS's /var is /private/var).
 * The JavaScript implementation, as Node's module resolver uses: unlike the native one it keeps
 * Windows 8.3 short names (C:\Users\RUNNER~1) as they are.
 */
export function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const ANSI = /\u001b\[[0-9;]*m/g;
/** Longest failure message kept for a report. */
const MESSAGE_LIMIT = 300;

/** A failure's message as reports show it: the cause of a wrapped test failure, no colours, bounded. */
export function firstMessage(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  const e = err as { code?: string; cause?: unknown };
  // node:test wraps what a test threw in an ERR_TEST_FAILURE whose cause is the real error.
  const inner = e.code === 'ERR_TEST_FAILURE' && e.cause !== undefined && e.cause !== null ? e.cause : err;
  const m = (typeof inner === 'object' && inner !== null && 'message' in inner ? String((inner as Error).message) : String(inner)).replace(ANSI, '');
  return m.length > MESSAGE_LIMIT ? `${m.slice(0, MESSAGE_LIMIT - 3)}...` : m;
}

/** Whether two runs of a test hit the same sites the same number of times. */
export function sameHits(a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  return true;
}
