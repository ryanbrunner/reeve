/**
 * Throwaway: a rate-limit reading close to the line, so the header's warning
 * can be looked at on purpose rather than waited for.
 *
 * The readout shows whatever the newest reading is, and this one is stamped two
 * minutes ago — it outranks the real ones until a run reports again. Point it
 * at a scratch database unless that is what you want:
 *
 *   REEVE_DB=/tmp/usage.db tsx src/spikes/seed-usage-warning.ts            # 5-hour at 93%, warning
 *   REEVE_DB=/tmp/usage.db tsx src/spikes/seed-usage-warning.ts rejected   # 5-hour spent
 *   REEVE_DB=/tmp/usage.db REEVE_PORT=4399 npm start
 *
 * The server reads it at boot, so start (or restart) it afterwards.
 */
import { desc } from 'drizzle-orm';
import { createApp } from '../index.js';
import { createCard, insertEvents, insertRun, listRepos, nextSeq } from '../db/queries.js';
import { run as runTable } from '../db/schema.js';
import { RATE_LIMIT_KIND } from '../usage.js';

const { db } = createApp();
const rejected = process.argv[2] === 'rejected';

// Onto the newest run if there is one, so the board is left as it was. A
// fresh database has none, and an event has to belong to a run.
let runId = db.select({ id: runTable.id }).from(runTable).orderBy(desc(runTable.createdAt)).limit(1).get()?.id;
if (!runId) {
  const card = createCard(db, { title: 'Monitor subscription usage', repoId: listRepos(db)[0]?.id ?? null, stage: 'planning' });
  runId = insertRun(db, { id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'planning', status: 'succeeded', cwd: '/tmp' }).id;
}

const at = Date.now() - 2 * 60_000;
// Seconds, as the stream sends them.
const fiveHourReset = Math.floor((Date.now() + 2 * 60 * 60_000) / 1000);
const sevenDayReset = Math.floor((Date.now() + 4 * 24 * 60 * 60_000) / 1000);
const five = rejected ? 1 : 0.93;

insertEvents(db, [{
  runId,
  seq: nextSeq(db, runId),
  kind: RATE_LIMIT_KIND,
  sdkUuid: null,
  at: new Date(at),
  payload: JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: rejected ? 'rejected' : 'allowed_warning',
      resetsAt: fiveHourReset,
      rateLimitType: 'five_hour',
      utilization: five,
      isUsingOverage: false,
      surpassedThreshold: 0.9,
      unifiedWindows: {
        five_hour: { utilization: five, resetsAt: fiveHourReset },
        seven_day: { utilization: 0.23, resetsAt: sevenDayReset },
      },
    },
    uuid: crypto.randomUUID(),
    session_id: 'seed-usage-warning',
  }),
}]);

console.log(`seeded a ${rejected ? 'spent' : '93%'} 5-hour reading on run ${runId.slice(0, 8)}; restart the server to see it`);
process.exit(0);
