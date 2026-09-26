/**
 * Single-file components: Vue, Svelte. Only `<script>` blocks are mutated; templates are not.
 *
 * Everything outside the script blocks is blanked to spaces, newlines kept, so the text parses as
 * one script with every offset — and so every line and column — identical to the original file.
 * Edits are then spliced into the original file at those offsets: the framework's own compiler
 * sees an ordinary component, and positions are reported against the file the user wrote.
 */
export interface SfcScripts {
  /** The file with everything but script content replaced by spaces. */
  blanked: string;
  /** `ts`, `tsx` or `js`: the dialect to parse the blanked text as. */
  lang: 'ts' | 'tsx' | 'js';
  /** Offsets where each block's code starts, for the runtime header. */
  blockStarts: number[];
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

export function isSfc(file: string): boolean {
  return /\.(vue|svelte)$/i.test(file);
}

export function sfcScripts(source: string): SfcScripts {
  const chars = source.split('');
  const keep = new Uint8Array(source.length);
  let lang: SfcScripts['lang'] = 'js';
  const blockStarts: number[] = [];
  for (const m of source.matchAll(SCRIPT)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const bodyStart = m.index! + m[0].indexOf('>') + 1;
    const l = /\blang\s*=\s*["']?(tsx|ts|typescript)["']?/i.exec(attrs)?.[1]?.toLowerCase();
    if (l === 'tsx') lang = 'tsx';
    else if ((l === 'ts' || l === 'typescript') && lang === 'js') lang = 'ts';
    for (let i = 0; i < body.length; i++) keep[bodyStart + i] = 1;
    const lead = body.search(/\S/);
    if (lead !== -1) blockStarts.push(bodyStart + lead);
  }
  for (let i = 0; i < chars.length; i++) {
    if (keep[i]) continue;
    const c = chars[i];
    if (c !== '\n' && c !== '\r') chars[i] = ' ';
  }
  return { blanked: chars.join(''), lang, blockStarts };
}
