import type { Db } from '../db/client.js';
import { insertEvents, nextSeq } from '../db/queries.js';
import { runBus } from './bus.js';

const FLUSH_MS = 50;
const FLUSH_ROWS = 32;

interface Pending {
  runId: string;
  seq: number;
  kind: string;
  sdkUuid: string | null;
  payload: string;
  at: Date;
}

/**
 * Batched event writer.
 *
 * better-sqlite3 is synchronous, so one INSERT per SDK message would block the
 * same event loop that serves SSE. Rows accumulate for FLUSH_MS or FLUSH_ROWS,
 * whichever comes first, and go in under a single transaction.
 *
 * Sequence numbers are allocated in memory per run and are monotonic: they are
 * the SSE event ids, so a gap or a repeat would corrupt client-side resume.
 */
export class EventWriter {
  private pending: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly seqs = new Map<string, number>();

  constructor(private readonly db: Db) {}

  append(runId: string, kind: string, payload: unknown, sdkUuid?: string | null): number {
    let seq = this.seqs.get(runId);
    if (seq === undefined) seq = nextSeq(this.db, runId) - 1;
    seq += 1;
    this.seqs.set(runId, seq);

    this.pending.push({
      runId,
      seq,
      kind,
      sdkUuid: sdkUuid ?? null,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      at: new Date(),
    });

    if (this.pending.length >= FLUSH_ROWS) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    return seq;
  }

  /** Persist first, publish second — never the other way round. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const rows = this.pending;
    this.pending = [];
    insertEvents(this.db, rows);
    for (const r of rows) {
      runBus.publish({ runId: r.runId, seq: r.seq, kind: r.kind, payload: r.payload, at: r.at.getTime() });
    }
  }

  /** Call when a run reaches a terminal state so the seq counter is released. */
  finish(runId: string): void {
    this.flush();
    this.seqs.delete(runId);
  }
}
