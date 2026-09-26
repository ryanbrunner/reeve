import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RunStatus } from '@reeve/shared';
import { api } from '../client.js';
import { EXIT, runOutcome, type ExitCode } from '../exit.js';
import { CliError, note, parseOrUsage, print, printJson, usageError } from '../output.js';
import { readSse } from '../sse.js';
import { renderEvent } from '../transcript.js';

/** Before reconnecting to a stream that closed with the run still going. */
const RECONNECT_MS = 1_000;

/**
 * Print a run's transcript from the start, then live, until the run ends.
 * Resolves with the exit code its ending means.
 *
 * The server closes the stream itself once the run is over, with an `end`
 * event saying how. A stream that closes without one was cut — a proxy, a
 * restart — and is reopened from the last seq it delivered, which the server
 * replays from; a server that has gone altogether fails the reconnect.
 */
export async function followRun(runId: string, opts: { json: boolean }): Promise<ExitCode> {
  // The events route answers a run it has never heard of with an empty stream
  // and a `failed` end. Asking first turns a mistyped id into a message.
  const run = await api.run(runId);
  if (!opts.json) note(`following ${run.kind} run ${run.id} (${run.stage}, ${run.status})`);

  let since = 0;
  for (;;) {
    const res = await api.events(runId, since);
    if (!res.body) throw new CliError('the event stream had no body');
    for await (const e of readSse(res.body)) {
      if (e.event === 'ping') continue;
      if (e.event === 'end') {
        const { status } = JSON.parse(e.data) as { status: RunStatus };
        if (opts.json) print(JSON.stringify({ seq: null, kind: 'end', data: { status } }));
        else note(`run ${status}`);
        return runOutcome(status) ?? EXIT.error;
      }
      if (e.id !== null) since = Number(e.id);
      if (opts.json) {
        // One event per line, so a reader can act on each as it lands.
        print(JSON.stringify({ seq: since, kind: e.event, data: JSON.parse(e.data) as unknown }));
      } else {
        for (const line of renderEvent(e.event, e.data)) print(line);
      }
    }
    await sleep(RECONNECT_MS);
  }
}

async function stop(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  const [runId] = positionals;
  if (!runId || positionals.length > 1) throw usageError('reeve run stop takes one run id');
  const run = await api.stopRun(runId);
  if (values.json) return printJson(run);
  note(`stopped run ${run.id} (${run.status})`);
}

async function follow(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  const [runId] = positionals;
  if (!runId || positionals.length > 1) throw usageError('reeve run follow takes one run id');
  process.exitCode = await followRun(runId, { json: values.json ?? false });
}

export const runCommands: Record<string, (args: string[]) => Promise<void>> = { stop, follow };
