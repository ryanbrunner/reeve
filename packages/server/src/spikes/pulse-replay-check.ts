/**
 * Throwaway check on the live cost estimate, with no API credit: replays a
 * recorded run's events through `Pulse` and prices every assistant message's
 * tokens (shared/pricing.ts), then sets the estimate beside the exact figures
 * the SDK reported at each turn's end. Run it against any scratch board a
 * flow check left behind:
 *
 *   REEVE_DB=/tmp/worker-flow.db npx tsx packages/server/src/spikes/pulse-replay-check.ts
 */
import { costOf, type TokenUsage } from '@reeve/shared';
import { openDatabase } from '../db/client.js';
import { config } from '../config.js';
import { eventsSince } from '../db/queries.js';
import { run as runTable } from '../db/schema.js';
import { Pulse } from '../runs/claude.js';
import { stageDefinition } from '../stages/index.js';

if (!process.env.REEVE_DB) throw new Error('give this the scratch REEVE_DB a flow check left');
const db = openDatabase(config.dbFile);

for (const r of db.select().from(runTable).all()) {
  if (r.kind !== 'claude' || r.task || r.parentRunId) continue;
  const stage = stageDefinition(r.stage as never);
  if (!stage) continue;
  const pulse = new Pulse(stage as never, 0, new Set());
  // Every message priced, never reset, to set against the SDK's last total.
  const seen = new Map<string, number>();
  let lastExact = 0;
  // The estimate as it stood just before each exact figure, against that figure.
  const checks: string[] = [];
  for (const e of eventsSince(db, r.id, 0)) {
    const peek = JSON.parse(e.payload) as { type?: string; total_cost_usd?: number };
    if (peek.type === 'result' && typeof peek.total_cost_usd === 'number') {
      const before = pulse.read(null).costUsd;
      if (before !== null) checks.push(`${(before / peek.total_cost_usd).toFixed(2)}`);
    }
    const message = JSON.parse(e.payload) as { type?: string; message?: { id?: string; model?: string; usage?: TokenUsage }; total_cost_usd?: number };
    if (!message.type) continue;
    if (message.type === 'result' && typeof message.total_cost_usd === 'number') lastExact = message.total_cost_usd;
    if (message.type === 'assistant' && message.message?.id && message.message.usage) {
      seen.set(message.message.id, costOf(message.message.model, message.message.usage) ?? NaN);
    }
    pulse.observe(message as never);
  }
  const estimated = [...seen.values()].reduce((a, b) => a + b, 0);
  const read = pulse.read(stage.maxBudgetUsd);
  console.log(
    `${r.stage.padEnd(12)} ${r.status.padEnd(10)} exact=$${lastExact.toFixed(4)} priced-from-tokens=$${estimated.toFixed(4)} ` +
      `ratio=${(estimated / lastExact).toFixed(2)} estimate/exact at each turn's end=[${checks.join(' ')}] pulse=${JSON.stringify({ cost: read.costUsd?.toFixed(4), exact: read.costExact, inFlight: read.inFlight.length, turns: read.turns })}`,
  );
}
