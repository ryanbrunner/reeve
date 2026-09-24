/**
 * Throwaway check on the capture pipeline: that it photographs a real page at
 * the width it was asked for, and that every way it can fail is reported rather
 * than thrown. The second half matters more than the first — a Testing run's
 * job is the acceptance criteria, and it must survive a browser that isn't
 * installed or a page that won't load.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { captureTargets } from '../capture/screenshot.js';
import { imageSize } from '../assets/store.js';

const page = (title: string, height: number) => `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title><style>body{margin:0;font:16px system-ui}
.box{height:${height}px;background:linear-gradient(#fbfaf8,#d8cfc0);padding:24px}</style></head>
<body><div class="box"><h1>${title}</h1><p>Captured by the spike.</p></div></body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/slow') return; // never responds: exercises the navigation timeout
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page(req.url === '/cart' ? 'Your cart' : 'Home', req.url === '/cart' ? 1400 : 400));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as { port: number };
const baseUrl = `http://127.0.0.1:${port}`;

if (process.argv.includes('--no-browser')) {
  const result = await captureTargets({ baseUrl, targets: [{ label: 'anything', path: '/', viewport: 1280 }] });
  console.log(JSON.stringify({ unavailable: result.unavailable }));
  server.close();
  process.exit(0);
}

const result = await captureTargets({
  baseUrl,
  targets: [
    { label: 'Cart with saved items', path: '/cart', viewport: 1280 },
    { label: 'Cart on mobile', path: '/cart', viewport: 390 },
    { label: 'Never loads', path: '/slow', viewport: 1280 },
  ],
});

const byLabel = new Map(result.captures.map((c) => [c.label, c]));
const wide = byLabel.get('Cart with saved items');
const narrow = byLabel.get('Cart on mobile');

const checks: Array<[string, boolean, string]> = [
  ['two pages captured', result.captures.length === 2, String(result.captures.length)],
  ['browser was available', result.unavailable === null, String(result.unavailable)],
  ['desktop shot is 1280 wide', wide?.width === 1280, `${wide?.width}x${wide?.height}`],
  ['mobile shot is 390 wide', narrow?.width === 390, `${narrow?.width}x${narrow?.height}`],
  ['full page, taller than the viewport', (wide?.height ?? 0) > 900, String(wide?.height)],
  ['bytes really are a PNG', imageSize(wide?.bytes ?? Buffer.alloc(0)) !== null, `${wide?.bytes.length ?? 0} bytes`],
  ['the page that never loads is reported, not thrown', result.failures.length === 1, JSON.stringify(result.failures)],
  ['...and names which one', result.failures[0]?.label === 'Never loads', String(result.failures[0]?.label)],
];

// The path that matters most: no browser installed at all. In a child process,
// because Playwright reads PLAYWRIGHT_BROWSERS_PATH when it is imported — set
// it here and this process would carry on using the browser it already found.
const missing = await (async () => {
  if (process.argv.includes('--no-browser')) return null;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    // --import tsx: this file is TypeScript, and the child is still a node.
    ['--import', 'tsx', process.argv[1]!, '--no-browser'],
    { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/tmp/reeve-no-browsers-here' } },
  );
  return JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { unavailable: string | null };
})();
if (missing) {
  checks.push(
    ['a missing browser degrades rather than throwing', missing.unavailable !== null, String(missing.unavailable).slice(0, 80)],
    ['...and says how to fix it', (missing.unavailable ?? '').includes('playwright install'), ''],
  );
}

server.close();

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(failed === 0 ? '\ncapture works, and every way it fails is reported' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
