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
  console.log(`${ok ? 'observed' : 'FAIL    '} ${name}${detail ? ` — ${detail}` : ''}`);
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
    'content-type: image/png and no X-Content-Type-Options: nosniff — the server trusts the\n' +
    "uploader's own declared MIME type and never reads the bytes to check it. That is not stored\n" +
    'XSS by itself: per the WHATWG MIME-sniffing spec, when a server supplies an image/* type,\n' +
    "a browser only sniffs among image signatures and keeps the declared type on a mismatch — it\n" +
    "never upgrades image/png to text/html. Current Chrome, Firefox and Safari show a broken image\n" +
    "on a direct navigation or in an <iframe>, not the HTML. (The 'sniff for scriptable content'\n" +
    'behaviour that used to make this exploitable was old IE, not anything shipping today.) And\n' +
    "CONTENT_TYPES only maps png/jpeg/webp, so text/html and image/svg+xml are rejected outright —\n" +
    'the allowlist is doing real work here. What is real: the content-type is unverified\n' +
    'data-integrity, worth an X-Content-Type-Options: nosniff header as defense in depth against a\n' +
    'future browser, a future allowlist entry, or a client that does sniff, but not an exploitable\n' +
    'path against the browsers in use today.',
);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exit(failures === 0 ? 0 : 1);
