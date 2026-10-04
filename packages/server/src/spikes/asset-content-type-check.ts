/**
 * Security review of `POST /api/cards/:id/assets` and `GET /api/assets/:id`:
 * does the server believe what it is told about an upload's bytes, and does
 * it tell the browser firmly enough not to guess otherwise?
 *
 *   REEVE_DB=/tmp/reeve-asset.db npx tsx packages/server/src/spikes/asset-content-type-check.ts
 *
 * In-process only — `app.request()`, never a listening port.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-asset-'));
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(scratch, 'assets');

const { createApp } = await import('../index.js');
const { createCard } = await import('../db/queries.js');
const { app, db } = createApp();

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const card = createCard(db, { title: 'asset content-type check', kind: 'task' });

console.log('--- uploading bytes that are not a PNG, labelled as one ---');
// `routes.post('/:id/assets')` in detail.ts checks only
// `CONTENT_TYPES[file.type]` — the MIME type the multipart part itself
// declares, which the uploader (here, this spike, standing in for anything
// a forged cross-site multipart POST could send — multipart/form-data is
// itself a "simple" content-type, so this needs no preflight either) picks
// for itself. Nothing reads the bytes to check.
const payload = '<html><body><script>document.title=document.cookie</script>ok</body></html>';
const form = new FormData();
form.append('file', new File([payload], 'not-a-png.png', { type: 'image/png' }));

const uploaded = await app.request(`/api/cards/${card.id}/assets`, { method: 'POST', body: form });
check('the upload is accepted', uploaded.status === 201, `status ${uploaded.status}`);
const asset = (await uploaded.clone().json()) as { id: string };

console.log('\n--- what the asset route serves it back as ---');
const served = await app.request(`/api/assets/${asset.id}`);
check('served with the content-type the uploader claimed, not the content', served.headers.get('content-type') === 'image/png');
check(
  'no X-Content-Type-Options: nosniff is set',
  served.headers.get('x-content-type-options') === null,
);
const bytes = await served.clone().text();
check('the HTML bytes are served verbatim', bytes === payload);

console.log('\n--- what this adds up to ---');
console.log(
  'An upload labelled image/png but containing HTML is accepted, stored, and served back with\n' +
    'content-type: image/png and no X-Content-Type-Options: nosniff. An <img src> cannot run it —\n' +
    'browsers do not execute an image destination as a document — but the asset route answers any\n' +
    'request for /api/assets/<id>, including a top-level navigation or an <iframe src>. Without\n' +
    "nosniff, a browser that content-sniffs the response (Chrome's \"sniff for scriptable content\"\n" +
    'applies when the declared type is not a strict image/audio/video type it trusts outright, and\n' +
    'its PNG-signature check would fail here) may render these bytes as HTML rather than as a\n' +
    'broken image, turning a stored \"mockup\" or pasted image into stored XSS on the asset origin —\n' +
    'the same origin that serves the API. This is reachable from any page that can reach the asset\n' +
    'POST at all (see csrf-check.ts for that it needs no Origin/Host/content-type to do so), given\n' +
    'only a card id, which /board hands out to anything that can read it.',
);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exit(failures === 0 ? 0 : 1);
