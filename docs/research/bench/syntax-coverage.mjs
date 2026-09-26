import { parseSync } from 'oxc-parser';
import * as bp from '@babel/parser';
import swc from '@swc/core';
const src = `
enum Color { Red = 1, Green = Red + 1 }
const enum K { A }
namespace NS { export const x = 1 }
@sealed class Svc { @inject() accessor dep!: Dep; constructor(private readonly a: number) {} @log m<const T extends readonly unknown[]>(t: T) { return t.length > 0 && this.a >= 1; } }
const cfg = { port: 80 } satisfies Config;
async function f() { using r = open(); await using s = await openAsync(); return r ?? s; }
const el = <div className={a ? "x" : "y"}>{items.map((i: number) => <Item key={i} v={i * 2} />)}</div>;
let v = <T,>(x: T) => x as unknown as T;
export type { Foo } from "./foo";
import json from "./a.json" with { type: "json" };
label: for (const x of xs) { if (x!.y?.z) break label; }
`;
for (const [n, fn] of [
 ['oxc', () => { const r = parseSync('a.tsx', src); return r.errors.map(e=>e.message); }],
 ['babel', () => { try { bp.parse(src, { sourceType:'module', plugins:['typescript','jsx','decorators','decoratorAutoAccessors','explicitResourceManagement','importAttributes'] }); return []; } catch (e) { return [e.message]; } }],
 ['swc', () => { try { swc.parseSync(src, { syntax:'typescript', tsx:true, decorators:true }); return []; } catch (e) { return [String(e).slice(0,200)]; } }],
]) console.log(n, JSON.stringify(fn()));
// UTF-16 spans check
const u = 'const s = "héllo😀"; const y = a + b;';
const r = parseSync('u.ts', u); const d = r.program.body[1].declarations[0].init; console.log('span slice:', JSON.stringify(u.slice(d.start, d.end)));
