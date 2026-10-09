import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { isTerminal, type RunStatus } from '@reeve/shared';
import type { Db } from '../db/client.js';
import { eventAt, eventsSince, getRun, latestSeq, runsForCard } from '../db/queries.js';
import { toApiRunSummary } from '../mappers.js';
import { runBus, type EmittedEvent } from '../runs/bus.js';
import { runRegistry } from '../runs/registry.js';

const PING_MS = 15_000;
/** How often an open stream checks whether its run has finished. One indexed row read. */
const STATUS_MS = 1_000;

export function runRoutes(db: Db) {
  const routes = new Hono();

  routes.get('/:id', (c) => {
    const run = getRun(db, c.req.param('id'));
    return run ? c.json(toApiRunSummary(run)) : c.json({ error: 'not found' }, 404);
  });

  /**
   * Live transcript.
   *
   * Resume takes Last-Event-ID *or* ?since=. Both are needed: the browser only
   * sends Last-Event-ID on its own automatic reconnect of a stream that already
   * delivered ids — a page reload constructs a fresh EventSource and sends
   * nothing.
   */
  routes.get('/:id/events', (c) => {
    const runId = c.req.param('id');
    const header = c.req.header('Last-Event-ID');
    const query = c.req.query('since');
    // `since=live` skips the replay entirely. A transcript viewer wants the
    // whole run; the card modal wants only the line telling it what Claude is
    // doing right now, and replaying thousands of messages to reach it would
    // be the expensive way to learn one fact.
    //
    // Checked BEFORE Last-Event-ID, and that order is the whole point: the
    // browser sends that header on every automatic reconnect once the stream
    // has delivered an id, so letting it win would make a live-only subscriber
    // replay the entire transcript the first time the connection blipped.
    const liveOnly = query === 'live';
    const since = liveOnly ? 0 : Number(header ?? query ?? '0') || 0;

    return streamSSE(c, async (stream) => {
      const buffered: EmittedEvent[] = [];
      let live = false;
      let lastSeq = since;

      const write = (e: { seq: number; kind: string; payload: string }) =>
        stream.writeSSE({ id: String(e.seq), event: e.kind, data: e.payload });

      // 1. Subscribe BEFORE reading the database. Reading first and subscribing
      //    second silently drops everything written in the gap.
      const unsubscribe = runBus.subscribe(runId, (e) => {
        if (live) void write(e);
        else buffered.push(e);
      });
      stream.onAbort(unsubscribe);

      try {
        // 2. Replay what is already persisted, unless the client asked for
        //    live only — in which case start from wherever the run has got to.
        if (liveOnly) {
          lastSeq = latestSeq(db, runId);
        } else {
          for (const row of eventsSince(db, runId, since)) {
            await write({ seq: row.seq, kind: row.kind, payload: row.payload });
            lastSeq = row.seq;
          }
        }

        // 3. Drain anything that arrived while replaying, discarding ids the
        //    replay already covered. Loop until empty: writes above yield, so
        //    more can land mid-drain. The flip to live has no await before it.
        while (buffered.length > 0) {
          const batch = buffered.splice(0);
          for (const e of batch) {
            if (e.seq > lastSeq) {
              await write(e);
              lastSeq = e.seq;
            }
          }
        }
        live = true;

        // 4. A finished run replays and closes — no hanging connection. The
        //    status is read far more often than the ping is sent: `reeve run
        //    follow` exits on `end`, and a script waiting on it should not sit
        //    out most of a ping interval after the run has stopped.
        let status = (getRun(db, runId)?.status ?? 'failed') as RunStatus;
        let sincePing = 0;
        while (!isTerminal(status) && !stream.aborted) {
          await stream.sleep(STATUS_MS);
          if (stream.aborted) break;
          sincePing += STATUS_MS;
          if (sincePing >= PING_MS) {
            await stream.writeSSE({ event: 'ping', data: '' });
            sincePing = 0;
          }
          status = (getRun(db, runId)?.status ?? 'failed') as RunStatus;
        }
        if (!stream.aborted) {
          await stream.writeSSE({ event: 'end', data: JSON.stringify({ status }) });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  /**
   * One stored event, whole: what a conversation row clipped, fetched when it
   * is opened.
   */
  routes.get('/:id/events/:seq', (c) => {
    const seq = Number(c.req.param('seq'));
    if (!Number.isInteger(seq) || seq < 1) return c.json({ error: 'bad seq' }, 400);
    const row = eventAt(db, c.req.param('id'), seq);
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ seq: row.seq, kind: row.kind, payload: JSON.parse(row.payload) as unknown });
  });

  routes.post('/:id/stop', async (c) => {
    const runId = c.req.param('id');
    const run = getRun(db, runId);
    if (!run) return c.json({ error: 'not found' }, 404);
    const active = runRegistry.get(runId);
    if (!active) {
      return c.json({ error: 'run is not active in this process', detail: `status=${run.status}` }, 409);
    }
    await active.stop('cancelled_by_user');
    return c.json(toApiRunSummary(getRun(db, runId)!));
  });

  routes.get('/card/:cardId', (c) => c.json(runsForCard(db, c.req.param('cardId')).map(toApiRunSummary)));

  return routes;
}
