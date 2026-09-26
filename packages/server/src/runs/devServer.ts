import type { DevServerUrlSource } from '@reeve/shared';
import type { Db } from '../db/client.js';
import { getRun, runsForCard, setRunStatus } from '../db/queries.js';
import type { Card, Repo } from '../db/schema.js';
import type { EventWriter } from './events.js';
import { findFreePort } from './ports.js';
import { runRegistry } from './registry.js';
import { announcedUrl, fillVars, serverEnv, serverVars, usesVar } from './serverUrl.js';
import { startShellRun } from './shell.js';

/**
 * The card's dev server, started if it isn't already.
 *
 * Extracted from the route that used to own it because the Testing stage needs
 * the same thing for a different reason: it cannot photograph a page that isn't
 * being served. Two code paths starting dev servers by slightly different rules
 * would eventually disagree about how many are running.
 */

export type DevServer =
  // `url` is null until the server says where it is; `waitForServer` waits for it.
  | { state: 'running'; runId: string; port: number | null; url: string | null; started: boolean }
  | { state: 'unavailable'; reason: string };

export async function ensureDevServer(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
): Promise<DevServer> {
  if (!repo.serverCommand) return { state: 'unavailable', reason: 'repo has no server command' };
  if (!card.worktreePath) return { state: 'unavailable', reason: 'card has no worktree' };

  const existing = runRegistry.all().find((r) => r.cardId === card.id && r.kind === 'server');
  if (existing) {
    // The registry knows it is alive; the row knows where it is, if anyone has said.
    const row = getRun(db, existing.runId);
    return { state: 'running', runId: existing.runId, port: row?.port ?? null, url: row?.url ?? null, started: false };
  }

  // Ports this card has used before are avoided rather than reused: a previous
  // server may still be letting go of one.
  const taken = new Set(runsForCard(db, card.id).map((r) => r.port).filter((p): p is number => p != null));
  const port = await findFreePort(taken);
  const vars = serverVars(card.id, card.branchName, port);

  // In the order of who knows best. A template is the repo saying outright; a
  // `{{port}}` in the command means the server was told the port as an
  // argument, not merely offered it in the environment. Either is on the row
  // from the start. Without one, the server's own output is the only witness.
  const known: { url: string; urlSource: DevServerUrlSource } | null = repo.serverUrl
    ? { url: fillVars(repo.serverUrl, vars), urlSource: 'repo' }
    : usesVar(repo.serverCommand, 'port')
      ? { url: `http://localhost:${port}`, urlSource: 'command' }
      : null;

  // Only the first address counts: Vite prints Local then Network, and a
  // server that reloads prints its banner again.
  let runId = '';
  let heard = false;
  const handle = startShellRun({
    db, writer, cardId: card.id, stage: card.stage,
    // Filled, so the run's log shows the port it was actually given.
    command: fillVars(repo.serverCommand, vars), cwd: card.worktreePath,
    env: serverEnv(vars),
    port, longLived: true,
    ...(known ?? {}),
    onLine: known
      ? undefined
      : (_kind, line) => {
          if (heard) return;
          const url = announcedUrl(line);
          if (!url) return;
          heard = true;
          setRunStatus(db, runId, { url, urlSource: 'announced' });
        },
  });
  runId = handle.runId;
  return { state: 'running', runId, port, url: known?.url ?? null, started: true };
}

export type ServerAnswer =
  | { state: 'answered'; url: string }
  /** Nothing ever said where it was serving: no template, no `{{port}}`, nothing printed. */
  | { state: 'no-url' }
  | { state: 'no-answer'; url: string }
  | { state: 'stopped'; url: string | null; reason: string | null };

/**
 * Wait for the server to say where it is, and then to actually answer there.
 *
 * `startShellRun` returns as soon as the process is spawned, which is well
 * before a bundler is ready to serve. Without this the first screenshot is of
 * a connection error. The URL is read off the row each time round, because a
 * server that announces itself only does so once it has started.
 */
export async function waitForServer(db: Db, runId: string, timeoutMs = 60_000): Promise<ServerAnswer> {
  const deadline = Date.now() + timeoutMs;
  let url: string | null = null;
  while (Date.now() < deadline) {
    const row = getRun(db, runId);
    url = row?.url ?? null;
    // A server that has exited is not going to start answering; a port
    // already in use ends it in a second, and waiting out the minute is waste.
    if (!row || (row.status !== 'running' && row.status !== 'queued')) {
      return { state: 'stopped', url, reason: row?.errorMessage ?? null };
    }
    if (url && (await answers(url))) return { state: 'answered', url };
    await new Promise((r) => setTimeout(r, 500));
  }
  return url ? { state: 'no-answer', url } : { state: 'no-url' };
}

/**
 * Local `.test` hosts are usually signed by a local authority Node does not
 * trust. A certificate complaint still means something is listening there,
 * and the browser that takes the pictures is told to accept it.
 */
const CERT_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

async function answers(url: string): Promise<boolean> {
  try {
    // Any answer at all means it is listening — a 404 on `/` is still a server.
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch (err) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return typeof code === 'string' && CERT_ERRORS.has(code);
  }
}
