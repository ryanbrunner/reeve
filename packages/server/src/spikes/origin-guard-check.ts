/**
 * Drives sameOriginGuard and requireJson (routes/security.ts) against a real
 * server on a spare port: a foreign Host, a foreign Origin, an opaque
 * ("null") Origin, a wrong content type, and the shapes that must still work
 * — the web app's own calls, the CLI's bodyless ones, a loopback dev-server
 * Origin, and the multipart asset upload.
 *
 *   REEVE_DB=/tmp/reeve-origin-guard.db npx tsx packages/server/src/spikes/origin-guard-check.ts
 */
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { config } from '../config.js';
import { createCard, createRepo } from '../db/queries.js';
import { createApp } from '../index.js';

const { app, db } = createApp();
const server = serve({ fetch: app.fetch, port: 0, hostname: config.hostname });
await new Promise((done) => server.once('listening', done));
const port = (server.address() as AddressInfo).port;
const url = `http://127.0.0.1:${port}`;

const repo = createRepo(db, {
  name: `origin-guard-${Date.now()}`, repoPath: '/tmp/origin-guard-missing',
  worktreeRoot: '/tmp/origin-guard-worktrees', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null, teardownCommand: null, finishCommand: null,
  laneColor: null,
});
const card = createCard(db, { title: 'origin guard check', repoId: repo.id });

let failures = 0;
async function check(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}: expected ${expected}, got ${actual}`);
  }
}

/**
 * `fetch` forbids setting Host at all — it's on the Fetch spec's forbidden
 * header list, the same rule that keeps a browser from doing this to a real
 * server. `http.request` carries no such rule, so it stands in for the raw
 * request a DNS-rebinding attacker's own client would send.
 */
function postWithHost(path: string, host: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1', port,
        path, method: 'POST',
        headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// A foreign Host: a DNS-rebinding attacker's own name, not the loopback one
// Reeve is listening on.
{
  const status = await postWithHost(`/api/cards/${card.id}/notes`, 'evil.example', JSON.stringify({ body: 'hi' }));
  await check('foreign Host is refused', status, 403);
}

// A foreign Origin, loopback Host: the page itself might be served from
// loopback (a proxy, a misconfigured tool) while still being someone else's.
{
  const res = await fetch(`${url}/api/cards/${card.id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ body: 'hi' }),
  });
  await check('foreign Origin is refused', res.status, 403);
}

// An opaque Origin — "null" — same as a sandboxed iframe or a local file.
{
  const res = await fetch(`${url}/api/cards/${card.id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'null' },
    body: JSON.stringify({ body: 'hi' }),
  });
  await check('opaque Origin is refused', res.status, 403);
}

// The dev server's own Origin, forwarded unchanged through Vite's proxy: a
// different loopback port must still be allowed.
{
  const res = await fetch(`${url}/api/cards/${card.id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ body: 'dev origin' }),
  });
  await check('loopback dev Origin is allowed', res.status, 201);
}

// No Origin at all: the CLI and curl never send one.
{
  const res = await fetch(`${url}/api/cards/${card.id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'no origin' }),
  });
  await check('missing Origin is allowed', res.status, 201);
}

// A cross-site <form method=post enctype="text/plain">: no preflight, and
// c.req.json() would otherwise have parsed it regardless.
{
  const res = await fetch(`${url}/api/cards/${card.id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ body: 'form post' }),
  });
  await check('text/plain body is refused', res.status, 415);
}

// The same, as a urlencoded form.
{
  const res = await fetch(`${url}/api/cards/${card.id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'body=urlencoded',
  });
  await check('urlencoded body is refused', res.status, 415);
}

// application/json with a charset suffix, as some clients send: still JSON.
{
  const res = await fetch(`${url}/api/cards/${card.id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ body: 'charset' }),
  });
  await check('application/json with a charset is allowed', res.status, 201);
}

// A bodyless POST to a route that happens to parse JSON — archive() with no
// detachOpen, as both the web app and the CLI send it.
{
  const res = await fetch(`${url}/api/cards/${card.id}/archive`, { method: 'POST' });
  await check('bodyless POST to a JSON route is allowed', res.status, 200);
}

// The multipart asset upload: no JSON body, must not be caught by requireJson.
{
  const card2 = createCard(db, { title: 'origin guard check (assets)', repoId: repo.id });
  const form = new FormData();
  form.set('file', new File([Buffer.from([0, 1, 2, 3])], 'x.png', { type: 'image/png' }));
  const res = await fetch(`${url}/api/cards/${card2.id}/assets`, { method: 'POST', body: form });
  await check('multipart upload reaches the handler untouched', res.status, 201);
}

// A foreign Origin GET: reading the board is untouched by this card's scope.
{
  const res = await fetch(`${url}/api/board`, { headers: { origin: 'https://evil.example' } });
  await check('GET with a foreign Origin is unaffected', res.status, 200);
}

server.close();
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
