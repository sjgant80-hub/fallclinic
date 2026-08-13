// build-page.mjs — put the GATED kernel inside the page, so the code the gate attacks is the code
// that runs in front of a clinician.
//
// ⚑ WHY INLINE RATHER THAN IMPORT. fallclinic is a single-file offline PWA: a clinic keeps working
// when the broadband does. An `import './clinic.mjs'` would quietly make the tool need a second file
// and a server, so the kernel is injected verbatim between two markers instead.
//
// ⚑ AND WHY VERBATIM. If this file could edit the kernel on the way in, the thing that was gated and
// the thing that ships would be two different programs, and the green gate would be about neither.
import { readFileSync, writeFileSync } from 'node:fs';

const OPEN = '/* __CLINIC_KERNEL__ */';
const CLOSE = '/* __END_CLINIC_KERNEL__ */';

const kernel = readFileSync('clinic.mjs', 'utf8')
  // ES-module syntax cannot appear in a classic <script>. Only the export KEYWORD is removed; not one
  // character of logic is touched, and the `\r?` matters because these files are CRLF.
  .replace(/^export default[\s\S]*?;\s*$/m, '')
  .replace(/^export (function|const|async function)/gm, '$1')
  .replace(/^export \{[^}]*\};?\s*$/gm, '');

const html = readFileSync('index.html', 'utf8');
const a = html.indexOf(OPEN), b = html.indexOf(CLOSE);
if (a < 0 || b < 0) throw new Error('the kernel markers are missing from index.html — refusing to guess where the kernel goes');

const out = html.slice(0, a + OPEN.length) + '\n' + kernel + '\n' + html.slice(b);
writeFileSync('index.html', out);

// A page that silently shipped none of the kernel would still look fine. Check.
const check = readFileSync('index.html', 'utf8');
for (const fn of ['function checkInteractions', 'function cdBalance', 'function verifyAuditChain', 'function severityRank']) {
  if (!check.includes(fn)) throw new Error(`the page does not contain ${fn} — the inline did not take`);
}
if (/^export /m.test(check.slice(a, check.indexOf(CLOSE)))) throw new Error('module syntax survived into the page');
console.log(`index.html — kernel inlined, ${kernel.split('\n').length} lines, page ${(out.length / 1024).toFixed(0)}KB`);
