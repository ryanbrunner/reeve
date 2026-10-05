import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DevServerUrlSource, StopReason } from '@reeve/shared';
import type { Db } from '../db/client.js';
import { insertRun, setRunStatus } from '../db/queries.js';
import type { CardStage } from '../db/schema.js';
import type { EventWriter } from './events.js';
import { runRegistry } from './registry.js';

const SIGKILL_GRACE_MS = 5_000;

export interface ShellRunOptions {
  db: Db;
  writer: EventWriter;
  cardId: string;
  stage: CardStage;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  port?: number;
  /** Where a server can be reached, when that is known before it starts. See `run.url`. */
  url?: string;
  urlSource?: DevServerUrlSource;
  /** A server keeps running until stopped; a task is expected to exit. */
  longLived?: boolean;
  /** Work beside the stage, found again by `liveTaskRun`. See the column on `run`. */
  task?: string;
  /** Each line as it is logged, for a caller waiting on something the command prints. */
  onLine?: (kind: 'stdout' | 'stderr', line: string) => void;
}

export interface ShellRunHandle {
  runId: string;
  /** Resolves when the process exits. A long-lived server resolves on stop. */
  done: Promise<{ exitCode: number | null; stopReason: StopReason }>;
}

/**
 * Runs a repo's command (setup, seed, test, or the dev server) or a tool beside
 * the stage (a review in Crit) and streams its output into run_event, so shell
 * output and Claude transcripts render through one component and one SSE
 * endpoint.
 */
export function startShellRun(opts: ShellRunOptions): ShellRunHandle {
  const { db, writer, cardId, stage, command, cwd, env, port, url, urlSource, longLived = false, task, onLine } = opts;

  const run = insertRun(db, {
    id: crypto.randomUUID(),
    cardId,
    kind: longLived ? 'server' : 'shell',
    stage,
    status: 'running',
    task: task ?? null,
    command,
    cwd,
    port: port ?? null,
    url: url ?? null,
    urlSource: urlSource ?? null,
    startedAt: new Date(),
  });
  const runId = run.id;

  // Where this Reeve keeps its board is not the command's business. Inherited,
  // a worktree's own Reeve would open the live database and reap its runs, and
  // a seed would write fixtures into it; left unset, a checkout's server falls
  // back to its own `data/`. A value the command sets itself still wins.
  const inherited = { ...process.env };
  delete inherited['REEVE_DB'];
  delete inherited['REEVE_ASSETS'];

  const child = spawn(command, {
    cwd,
    shell: true,
    // Its own process group: `npm run dev` forks a bundler, and killing only the
    // shell leaves that orphaned holding the port.
    detached: true,
    env: { ...inherited, ...env, ...(port ? { PORT: String(port), REEVE_PORT: String(port) } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  setRunStatus(db, runId, { pid: child.pid ?? null });
  writer.append(runId, 'command', { command, cwd, pid: child.pid, port: port ?? null });

  for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      writer.append(runId, kind, { line });
      onLine?.(kind, line);
    });
  }

  let stopReason: StopReason = 'completed';
  // Set once `stop()` has armed its own grace timer, so the sweep below does
  // not arm a second one racing it.
  let stopping = false;
  let sweepTimer: NodeJS.Timeout | null = null;

  const done = new Promise<{ exitCode: number | null; stopReason: StopReason }>((resolve) => {
    child.on('error', (err) => {
      stopReason = 'sdk_error';
      writer.append(runId, 'error', { message: err.message });
    });
    // A server command can be two cooperating processes rather than one —
    // `npm run dev`'s `backend & frontend` pattern backgrounds one and runs
    // the other in the shell's own foreground. `exit` fires on whichever
    // process we are actually tracking (the shell), but `close` waits for
    // every stdio stream to let go too, and a backgrounded sibling still
    // holding stdout/stderr never lets go on its own — so if the foreground
    // half dies first, `close` would never come and the run would read
    // `running` forever. Sweeping the group here, from `exit`, means a half
    // left behind is stopped and the run still finishes.
    child.on('exit', () => {
      if (!longLived || stopping) return;
      const left = groupSize(child.pid);
      if (left) {
        writer.append(runId, 'error', {
          message: `this server's command exited, but left ${left} other process${left === 1 ? '' : 'es'} behind — stopping ${left === 1 ? 'it' : 'them'} too`,
        });
      }
      killGroup(child.pid, 'SIGTERM');
      sweepTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), SIGKILL_GRACE_MS);
    });
    child.on('close', (code, signal) => {
      if (sweepTimer) clearTimeout(sweepTimer);
      writer.append(runId, 'exit', { code, signal });
      writer.finish(runId);
      const cancelled = stopReason === 'cancelled_by_user';
      setRunStatus(db, runId, {
        status: cancelled ? 'cancelled' : code === 0 ? 'succeeded' : 'failed',
        stopReason: cancelled ? 'cancelled_by_user' : code === 0 ? 'completed' : stopReason,
        exitCode: code,
        finishedAt: new Date(),
        errorMessage: !cancelled && code !== 0 ? `exited with code ${code}${signal ? ` (${signal})` : ''}` : null,
      });
      runRegistry.unregister(runId);
      resolve({ exitCode: code, stopReason });
    });
  });

  runRegistry.register({
    runId,
    cardId,
    kind: longLived ? 'server' : 'shell',
    stop: async (reason) => {
      stopping = true;
      stopReason = reason;
      setRunStatus(db, runId, { status: 'stopping' });
      killGroup(child.pid, 'SIGTERM');
      const timer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), SIGKILL_GRACE_MS);
      await done.finally(() => clearTimeout(timer));
    },
  });

  return { runId, done };
}

/**
 * How many processes are still in `pid`'s group — `detached: true` makes it
 * the group's own id, which outlives whichever member happened to lead it.
 * `null` means the count couldn't be taken at all, not that the group is
 * empty; `pgrep` exits 1 for "no match", which is a real, countable zero.
 */
function groupSize(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    return execFileSync('pgrep', ['-g', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
  } catch (err) {
    return (err as { status?: number }).status === 1 ? 0 : null;
  }
}

/** Negative pid targets the whole group — the entire point of `detached`. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

export { killGroup };
