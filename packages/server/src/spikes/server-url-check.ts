/**
 * Checks where Reeve says a card's dev server is, for each way it can know,
 * without spending API credit: a server that ignores PORT and prints its own
 * address, one handed `{{port}}` in its command, a repo URL template, and a
 * server that says nothing at all. Also that the repo form refuses a variable
 * nobody fills, and that setup and server commands see the card's names.
 *
 * Builds a throwaway git repo in /tmp and real worktrees of it, and starts
 * real servers on loopback. Needs a scratch database:
 *
 *   REEVE_DB=/tmp/reeve-server-url.db npx tsx packages/server/src/spikes/server-url-check.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiCard, ApiRepo, CardDetail } from '@reeve/shared';
import { createApp } from '../index.js';
import { getCard, getRun, listRepos } from '../db/queries.js';
import { waitForServer } from '../runs/devServer.js';
import { announcedUrl } from '../runs/serverUrl.js';
import { ensureWorktree } from '../startStage.js';

if (!process.env['REEVE_DB']) {
  console.error('Set REEVE_DB to a scratch database; this starts servers on whatever board it is given.');
  process.exit(2);
}

const { app, db, writer } = createApp();

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail]);

// --- The parser on its own, against what real servers print ------------------

const printed: Array<[string, string, string | null]> = [
  ['Vite, colour codes inside the URL', '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m', 'http://localhost:5174'],
  ['Vite Network line is not loopback', '  ➜  Network: http://192.168.1.20:5174/', null],
  ['Next', '   - Local:        http://localhost:3000', 'http://localhost:3000'],
  ['Puma', '* Listening on http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
  ['0.0.0.0 reads as localhost', 'Server running at http://0.0.0.0:8080/app', 'http://localhost:8080/app'],
  ['a docs link is not an address', 'Docs: https://vitejs.dev/guide/', null],
  ['trailing punctuation is dropped', 'Ready on http://localhost:4000.', 'http://localhost:4000'],
];
for (const [name, line, want] of printed) {
  const got = announcedUrl(line);
  check(`parse: ${name}`, got === want, String(got));
}

// --- A repo whose "server" is a script that can behave four ways ---------------

const root = mkdtempSync(join(tmpdir(), 'reeve-server-url-'));
const repoPath = join(root, 'site');
mkdirSync(repoPath);
const g = (...a: string[]) => execFileSync('git', ['-C', repoPath, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 'T');
// announce: ignores PORT, binds anywhere, prints Vite's banner around a docs link.
// arg: listens on the port it is given as an argument. silent: binds, prints nothing.
writeFileSync(
  join(repoPath, 'serve.mjs'),
  `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const [mode, arg] = process.argv.slice(2);
writeFileSync('server-env.json', JSON.stringify({ PORT: process.env.PORT, REEVE_WORKTREE: process.env.REEVE_WORKTREE, REEVE_SLUG: process.env.REEVE_SLUG }));
const server = createServer((_q, r) => r.end('ok'));
server.listen(mode === 'arg' ? Number(arg) : 0, '127.0.0.1', () => {
  const { port } = server.address();
  if (mode !== 'announce') return;
  console.log('  Docs: https://vitejs.dev/guide/');
  console.log('  \\x1b[32m➜\\x1b[39m  \\x1b[1mLocal\\x1b[22m:   \\x1b[36mhttp://localhost:\\x1b[1m' + port + '\\x1b[22m/\\x1b[39m');
  console.log('  ➜  Network: http://192.168.1.20:' + port + '/');
});
`,
);
writeFileSync(
  join(repoPath, 'setup.mjs'),
  `import { writeFileSync } from 'node:fs';
writeFileSync('setup-env.json', JSON.stringify({ REEVE_WORKTREE: process.env.REEVE_WORKTREE, REEVE_SLUG: process.env.REEVE_SLUG }));
`,
);
g('add', '-A');
g('commit', '-qm', 'base');

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const created = await call<ApiRepo>('POST', '/api/repos', {
  name: `server-url-${Date.now()}`,
  repoPath,
  setupCommand: 'node setup.mjs',
  serverCommand: 'node serve.mjs announce',
});
if (created.status !== 201) throw new Error(`could not create the repo: ${JSON.stringify(created.json)}`);
const repoId = created.json.id;

// --- The repo form refuses what it cannot fill --------------------------------

const refused = await call<{ error: string; detail: string }>('PATCH', `/api/repos/${repoId}`, { serverUrl: 'https://{{prot}}.test' });
check('Server URL with {{prot}} is refused', refused.status === 400, String(refused.status));
check('...naming the variable', refused.json.detail?.includes('{{prot}}') ?? false, refused.json.detail);
const badCommand = await call<{ detail: string }>('PATCH', `/api/repos/${repoId}`, { serverCommand: 'vite --port {{prot}}' });
check('Server command with {{prot}} is refused', badCommand.status === 400, badCommand.json.detail);
const noScheme = await call<{ detail: string }>('PATCH', `/api/repos/${repoId}`, { serverUrl: '{{slug}}.test' });
check('Server URL without http(s) is refused', noScheme.status === 400, noScheme.json.detail);
const goTemplate = await call('PATCH', `/api/repos/${repoId}`, { serverCommand: "docker ps --format '{{.Names}}'" });
check('a command with {{.Names}} is accepted', goTemplate.status === 200, String(goTemplate.status));

// --- Each way of knowing, on a card of its own --------------------------------

const until = async <T>(read: () => T | null | undefined, ms: number): Promise<T | null> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = read();
    if (v != null) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

async function cardWithWorktree(title: string) {
  const card = (await call<ApiCard>('POST', '/api/cards', { title, repoId })).json;
  const repo = listRepos(db).find((r) => r.id === repoId)!;
  const tree = await ensureWorktree(db, writer, getCard(db, card.id)!, repo);
  // Setup runs in the background; its env is what this is waiting to read.
  if (!tree.reused && tree.setupRunId) {
    await until(() => (getRun(db, tree.setupRunId!)?.status === 'running' ? null : true), 10_000);
  }
  return getCard(db, card.id)!;
}

async function serve(
  label: string,
  repoPatch: Record<string, string | null>,
  expect: {
    source: string | null;
    // A pattern where the address cannot be known in advance: an announced
    // one is whatever port the OS handed the server.
    url: (card: NonNullable<ReturnType<typeof getCard>>, port: number | null) => string | RegExp | null;
  },
) {
  await call('PATCH', `/api/repos/${repoId}`, repoPatch);
  const card = await cardWithWorktree(label);
  const started = await call<{ runId: string; port: number | null; url: string | null }>('POST', `/api/cards/${card.id}/server`);
  if (started.status !== 201) {
    check(`${label}: server started`, false, JSON.stringify(started.json));
    return;
  }
  const { runId, port } = started.json;
  const want = expect.url(card, port);

  // What the Rail reads, polled as the Rail does, until the URL shows up.
  const detail = async () => (await call<CardDetail>('GET', `/api/cards/${card.id}/detail`)).json;
  let server = (await detail()).worktree.server;
  const deadline = Date.now() + (want ? 10_000 : 3_000);
  while (!server?.url && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    server = (await detail()).worktree.server;
  }
  const matches = want instanceof RegExp ? want.test(server?.url ?? '') : server?.url === want;
  check(`${label}: url`, matches, `${server?.url} (wanted ${want})`);
  check(`${label}: source`, (server?.urlSource ?? null) === expect.source, String(server?.urlSource));

  // What Testing does before its screenshots. A .test host will not resolve here.
  if (expect.source !== 'repo') {
    const answer = await waitForServer(db, runId, want ? 10_000 : 2_000);
    check(`${label}: Testing ${want ? 'reaches it' : 'reports no URL'}`, answer.state === (want ? 'answered' : 'no-url'), JSON.stringify(answer));
  }

  const env = join(card.worktreePath!, 'server-env.json');
  await until(() => (existsSync(env) ? true : null), 5_000);
  const seen = existsSync(env) ? (JSON.parse(readFileSync(env, 'utf8')) as Record<string, string>) : {};
  check(`${label}: server sees REEVE_WORKTREE`, seen['REEVE_WORKTREE'] === card.id.slice(0, 8), seen['REEVE_WORKTREE'] ?? '');
  check(`${label}: server sees REEVE_SLUG`, seen['REEVE_SLUG'] === card.branchName?.replace(/^reeve\//, ''), seen['REEVE_SLUG'] ?? '');

  await call('DELETE', `/api/cards/${card.id}/server`);
  return { card, runId, port };
}

// (a) Ignores PORT, prints where it is — Vite's banner, colour codes and all.
const a = await serve('announced', { serverCommand: 'node serve.mjs announce', serverUrl: null }, {
  source: 'announced',
  url: () => /^http:\/\/localhost:\d+$/,
});
if (a) {
  const url = getRun(db, a.runId)?.url ?? null;
  check('announced: not the port Reeve offered', url !== `http://localhost:${a.port}`, `offered ${a.port}`);
  const after = await waitForServer(db, a.runId, 2_000);
  check('announced: once stopped, Testing is told so at once', after.state === 'stopped', after.state);
}

// (b) `{{port}}` in the command.
const b = await serve('command', { serverCommand: 'node serve.mjs arg {{port}}', serverUrl: null }, {
  source: 'command',
  url: (_card, port) => `http://localhost:${port}`,
});
if (b) {
  const command = getRun(db, b.runId)?.command ?? '';
  check('command: the run records the real port', command === `node serve.mjs arg ${b.port}`, command);
}

// (c) A template on the repo, with the branch slug and the worktree name.
await serve('template slug', { serverCommand: 'node serve.mjs silent', serverUrl: 'https://{{slug}}.test' }, {
  source: 'repo',
  url: (card) => `https://${card.branchName!.replace(/^reeve\//, '')}.test`,
});
await serve('template worktree', { serverCommand: 'node serve.mjs silent', serverUrl: 'https://{{worktree}}.test' }, {
  source: 'repo',
  url: (card) => `https://${card.id.slice(0, 8)}.test`,
});

// (d) Nothing to go on.
const d = await serve('silent', { serverCommand: 'node serve.mjs silent', serverUrl: null }, {
  source: null,
  url: () => null,
});

// The setup command, which ran once per worktree before any of the servers.
if (d) {
  const setupEnv = join(d.card.worktreePath!, 'setup-env.json');
  const seen = existsSync(setupEnv) ? (JSON.parse(readFileSync(setupEnv, 'utf8')) as Record<string, string>) : {};
  check('setup sees REEVE_WORKTREE', seen['REEVE_WORKTREE'] === d.card.id.slice(0, 8), seen['REEVE_WORKTREE'] ?? 'no file');
  check('setup sees REEVE_SLUG', seen['REEVE_SLUG'] === d.card.branchName?.replace(/^reeve\//, ''), seen['REEVE_SLUG'] ?? 'no file');
}

rmSync(root, { recursive: true, force: true });

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(failed === 0 ? '\nevery URL came from something that knew' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
