import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { StopReason } from '@reeve/shared';
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
 * Runs a project command (setup, test, or the dev server) or a tool beside
 * the stage (a review in Crit) and streams its output into run_event, so shell
 * output and Claude transcripts render through one component and one SSE
 * endpoint.
 */
export function startShellRun(opts: ShellRunOptions): ShellRunHandle {
  const { db, writer, cardId, stage, command, cwd, env, port, longLived = false, task, onLine } = opts;

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
    startedAt: new Date(),
  });
  const runId = run.id;

  const child = spawn(command, {
    cwd,
    shell: true,
    // Its own process group: `npm run dev` forks a bundler, and killing only the
    // shell leaves that orphaned holding the port.
    detached: true,
    env: { ...process.env, ...env, ...(port ? { PORT: String(port), REEVE_PORT: String(port) } : {}) },
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

  const done = new Promise<{ exitCode: number | null; stopReason: StopReason }>((resolve) => {
    child.on('error', (err) => {
      stopReason = 'sdk_error';
      writer.append(runId, 'error', { message: err.message });
    });
    child.on('close', (code, signal) => {
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
      stopReason = reason;
      setRunStatus(db, runId, { status: 'stopping' });
      killGroup(child.pid, 'SIGTERM');
      const timer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), SIGKILL_GRACE_MS);
      await done.finally(() => clearTimeout(timer));
    },
  });

  return { runId, done };
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
