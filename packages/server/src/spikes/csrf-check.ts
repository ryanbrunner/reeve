/**
 * Security review of the HTTP boundary: can a page that is not Reeve's own
 * web app make the server do something, over loopback, with nothing but a
 * browser's own cross-origin fetch?
 *
 *   REEVE_DB=/tmp/reeve-csrf.db npx tsx packages/server/src/spikes/csrf-check.ts
 *
 * In-process only — `app.request()`, never a listening port — so this never
 * touches 4317 or a real checkout. What it proves and what it cannot:
 *
 *   - It can prove the server accepts a request with a forged `Origin` and
 *     `Host`, with no `application/json`, and runs the handler anyway: that
 *     is server-side fact, read straight off the Hono app.
 *   - It cannot drive an actual browser, so whether such a request reaches
 *     the server at all is a DNS-rebinding and `fetch(..., {mode: 'no-cors'})`
 *     question answered by the spec, not this process: a `no-cors` POST is a
 *     "simple request" and leaves for the wire with no preflight regardless
 *     of `Origin`, and a page that resolves to 127.0.0.1 (by rebinding, or by
 *     the victim simply visiting `http://127.0.0.1:4317` while it last showed
 *     an attacker-controlled tab) sends `Host: 127.0.0.1:4317` honestly; the
 *     interesting forged case is `Origin` from a page served elsewhere that
 *     then rebinds. Either way nothing here checks either header, so the
 *     result is the same.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-csrf-'));
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(scratch, 'assets');

const { createApp } = await import('../index.js');
const { app } = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// A real git repo for `POST /api/repos` to inspect — the same `inspectRepo`
// call a genuine request would trigger, so accepting the request really does
// mean running `git` against a path the request named.
const repoDir = mkdtempSync(join(tmpdir(), 'reeve-csrf-repo-'));
const g = (...a: string[]) => execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 'T');
writeFileSync(join(repoDir, 'README.md'), '# scratch\n');
g('add', '-A');
g('commit', '-qm', 'base');

console.log('--- route inventory: which methods a cross-site "simple request" can reach ---');
// A simple request (no preflight) is limited to GET/HEAD/POST with headers a
// <form> can send. PATCH and DELETE always preflight, and this server answers
// no `Access-Control-Allow-*` headers at all (grep found no cors() middleware
// anywhere in main.ts/index.ts), so a foreign page's preflight fails closed —
// for PATCH/DELETE specifically. GET and POST need no preflight to begin with.
const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes;
const byMethod = new Map<string, string[]>();
for (const r of routes) {
  if (r.method === 'ALL') continue;
  (byMethod.get(r.method) ?? byMethod.set(r.method, []).get(r.method)!).push(r.path);
}
for (const [method, paths] of byMethod) {
  const reachable = method === 'GET' || method === 'HEAD' || method === 'POST';
  console.log(`${method.padEnd(6)} (${reachable ? 'simple-request reachable' : 'preflighted'}): ${paths.length} route(s)`);
}
check('POST routes exist beyond the simple-request-safe GET/HEAD', (byMethod.get('POST')?.length ?? 0) > 0);

console.log('\n--- content-type: does c.req.json() care? ---');
// A cross-site <form> or fetch(..., {mode:'no-cors'}) cannot set an arbitrary
// request header, but CAN send `Content-Type: text/plain` with a body of its
// choosing — exactly what a JSON payload looks like as bytes. If the handler
// still parses it as JSON, the browser's preflight is never triggered and the
// side effect lands with the response unreadable to the attacker page.
const repoBody = JSON.stringify({ name: `csrf-text-plain-${Date.now()}`, repoPath: repoDir });
const plain = await app.request('/api/repos', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: repoBody,
});
check(
  'a JSON body sent as text/plain is still accepted',
  plain.status === 201,
  `status ${plain.status}: ${await plain.clone().text()}`,
);

const noType = await app.request('/api/repos', {
  method: 'POST',
  body: JSON.stringify({ name: `csrf-no-type-${Date.now()}`, repoPath: repoDir }),
});
check('a JSON body sent with no content-type header at all is also accepted', noType.status === 201, `status ${noType.status}`);

console.log('\n--- Host and Origin: does anything check them? ---');
const forged = await app.request('/api/repos', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://attacker.example',
    host: 'attacker.example',
  },
  body: JSON.stringify({ name: `csrf-forged-${Date.now()}`, repoPath: repoDir }),
});
check(
  'a request with a forged Origin and Host is accepted, same as a same-origin one',
  forged.status === 201,
  `status ${forged.status}: ${await forged.clone().text()}`,
);
check('no Access-Control-* header is sent back either way', ![...forged.headers.keys()].some((h) => h.toLowerCase().startsWith('access-control')));

console.log('\n--- what this adds up to ---');
console.log(
  'POST /api/repos is reachable as a simple cross-site request (no CORS preflight to fail),\n' +
    'accepts a JSON body under any content-type, and checks neither Host nor Origin. The same\n' +
    'router mounts POST /api/cards/:id/run (starts the stage\'s Claude session) and POST\n' +
    '/api/cards/:id/test (runs the repo\'s test command via startShellRun, spawn(..., {shell:true})),\n' +
    'both POST, both unauthenticated by the same absence of checks — read, not re-driven here,\n' +
    'to avoid starting a real Claude run or needing a card with a live worktree. A page open in\n' +
    'the same browser as Reeve, or one that DNS-rebinds to 127.0.0.1, can fire any of them blind.',
);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exit(failures === 0 ? 0 : 1);
