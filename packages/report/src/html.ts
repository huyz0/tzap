import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AnalysisResult } from '@tzap/model';
import { elementsReport } from './elements.js';

let bundle: string | undefined;

/** The mutation-testing-elements browser bundle, read once. It defines `<mutation-test-report-app>`. */
export function elementsBundle(): string {
  bundle ??= readFileSync(
    createRequire(import.meta.url).resolve('mutation-testing-elements/dist/mutation-test-elements.js'),
    'utf8',
  );
  return bundle;
}

/** Text that cannot close the `<script>` element it is inlined into, nor break a JS string literal. */
function scriptSafe(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * One self-contained page: the elements web component and the elements report inlined, as
 * StrykerJS's html reporter does. Opens from disk with no network and no server.
 */
export function htmlReport(result: AnalysisResult, js: string = elementsBundle()): string {
  // `<` escaped inside JSON strings, so no source text can end the script early.
  const report = JSON.stringify(elementsReport(result)).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tzap mutation report</title>
<script>
${scriptSafe(js)}
</script>
</head>
<body>
<mutation-test-report-app title-postfix="tzap">
Your browser does not support custom elements. Use a current browser to view this report.
</mutation-test-report-app>
<script>
document.querySelector('mutation-test-report-app').report = ${scriptSafe(report)};
</script>
</body>
</html>
`;
}
