import type { Db } from '../db/client.js';
import { runsForCard } from '../db/queries.js';
import type { Card, Project } from '../db/schema.js';
import type { EventWriter } from './events.js';
import { findFreePort } from './ports.js';
import { runRegistry } from './registry.js';
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
  | { state: 'running'; runId: string; port: number; url: string; started: boolean }
  | { state: 'unavailable'; reason: string };

export async function ensureDevServer(
  db: Db,
  writer: EventWriter,
  card: Card,
  project: Project,
): Promise<DevServer> {
  if (!project.serverCommand) return { state: 'unavailable', reason: 'project has no server command' };
  if (!card.worktreePath) return { state: 'unavailable', reason: 'card has no worktree' };

  const existing = runRegistry.all().find((r) => r.cardId === card.id && r.kind === 'server');
  if (existing) {
    // The registry knows it is alive; the row knows which port it took.
    const row = runsForCard(db, card.id).find((r) => r.id === existing.runId);
    const port = row?.port;
    if (port) return { state: 'running', runId: existing.runId, port, url: `http://localhost:${port}`, started: false };
    return { state: 'unavailable', reason: 'a server is running but its port was not recorded' };
  }

  // Ports this card has used before are avoided rather than reused: a previous
  // server may still be letting go of one.
  const taken = new Set(runsForCard(db, card.id).map((r) => r.port).filter((p): p is number => p != null));
  const port = await findFreePort(taken);
  const handle = startShellRun({
    db, writer, cardId: card.id, stage: card.stage,
    command: project.serverCommand, cwd: card.worktreePath,
    port, longLived: true,
  });
  return { state: 'running', runId: handle.runId, port, url: `http://localhost:${port}`, started: true };
}

/**
 * Wait for the server to actually answer.
 *
 * `startShellRun` returns as soon as the process is spawned, which is well
 * before a bundler is ready to serve. Without this the first screenshot is of
 * a connection error.
 */
export async function waitForServer(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any answer at all means it is listening — a 404 on `/` is still a server.
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}
