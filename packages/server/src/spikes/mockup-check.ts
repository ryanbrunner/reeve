/**
 * Throwaway check on drawing mockups from the HTML Planning returns: that each
 * renders at the width it was drawn for, that a document reaching for the
 * network or running a script can neither hang the render nor change it, and
 * that a missing browser is reported rather than thrown — a plan must survive
 * all of these. Also that a plan stored before mockups existed still parses.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jsonSchemaFor, planningOutput } from '@reeve/shared';
import { renderMockups } from '../capture/screenshot.js';
import { imageSize } from '../assets/store.js';

const doc = (title: string, extra = '') => `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title><style>body{margin:0;font:16px system-ui}
.box{height:400px;background:linear-gradient(#fbfaf8,#d8cfc0);padding:24px}</style>${extra}</head>
<body><div class="box"><h1>${title}</h1><p>Drawn by the spike.</p></div></body></html>`;

if (process.argv.includes('--no-browser')) {
  const result = await renderMockups([{ label: 'anything', path: '/', viewport: 1280, html: doc('Anything') }]);
  console.log(JSON.stringify({ unavailable: result.unavailable }));
  process.exit(0);
}

const started = Date.now();
const result = await renderMockups([
  { label: 'Cart with saved items', path: '/cart', viewport: 1280, html: doc('Your cart') },
  { label: 'Cart on mobile', path: '/cart', viewport: 390, html: doc('Your cart') },
  {
    label: 'Reaches out',
    path: '/',
    viewport: 1280,
    // An address that never answers: without the network cut off, this image
    // and stylesheet would hold `load` until the timeout.
    html: doc('Reaches out', '<link rel="stylesheet" href="http://10.255.255.1/app.css">')
      .replace('</div>', '<img src="http://10.255.255.1/hero.png" width="200" height="100"></div>'),
  },
  {
    label: 'Runs a script',
    path: '/',
    viewport: 1280,
    html: doc('Runs a script').replace('</body>', "<script>document.body.style.height = '5000px'</script></body>"),
  },
]);
const elapsed = Date.now() - started;

const byLabel = new Map(result.captures.map((c) => [c.label, c]));
const wide = byLabel.get('Cart with saved items');
const narrow = byLabel.get('Cart on mobile');
const reaching = byLabel.get('Reaches out');
const scripted = byLabel.get('Runs a script');

const old = planningOutput.safeParse({
  summary: 'A plan from before mockups.',
  details: [],
  steps: [],
  open_questions: [],
  acceptance_criteria: [],
  captures: [],
  files_to_touch: [],
  risk: 'low',
});

const checks: Array<[string, boolean, string]> = [
  ['browser was available', result.unavailable === null, String(result.unavailable)],
  ['every mockup drawn', result.captures.length === 4, `${result.captures.length}, failures ${JSON.stringify(result.failures)}`],
  ['desktop mockup is 1280 wide', wide?.width === 1280, `${wide?.width}x${wide?.height}`],
  ['mobile mockup is 390 wide', narrow?.width === 390, `${narrow?.width}x${narrow?.height}`],
  ['bytes really are a PNG', imageSize(wide?.bytes ?? Buffer.alloc(0)) !== null, `${wide?.bytes.length ?? 0} bytes`],
  ['...and the size matches the header', imageSize(wide?.bytes ?? Buffer.alloc(0))?.width === 1280, ''],
  ['an external request does not hang the render', reaching !== undefined && elapsed < 10_000, `${elapsed}ms`],
  ['a script does not run', (scripted?.height ?? 0) < 5000, `${scripted?.height}px tall`],
  ['a plan without mockups still parses', old.success, old.success ? '' : old.error.message.slice(0, 80)],
  ['...and reads as none', old.success && old.data.mockups.length === 0, ''],
  ['the contract still converts', (() => { try { jsonSchemaFor(planningOutput); return true; } catch { return false; } })(), ''],
];

// No browser at all, in a child process for the reason capture-check gives:
// Playwright reads PLAYWRIGHT_BROWSERS_PATH when it is imported.
const { stdout } = await promisify(execFile)(
  process.execPath,
  ['--import', 'tsx', process.argv[1]!, '--no-browser'],
  { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/tmp/reeve-no-browsers-here' } },
);
const missing = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { unavailable: string | null };
checks.push(
  ['a missing browser degrades rather than throwing', missing.unavailable !== null, String(missing.unavailable).slice(0, 80)],
  ['...and says how to fix it', (missing.unavailable ?? '').includes('playwright install'), ''],
);

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(failed === 0 ? '\nmockups render, and every way they fail is reported' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
