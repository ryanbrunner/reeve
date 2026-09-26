import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardResponse } from '@reeve/shared';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createCard, createRepo, insertEvents, insertRun } from '../db/queries.js';
import { apiRoutes } from '../routes/api.js';
import { EventWriter } from '../runs/events.js';
import { RATE_LIMIT_KIND, recordRateLimit, seedUsage, usageState } from '../usage.js';

/**
 * The usage readout, against a throwaway database and made-up payloads shaped
 * like the real ones. The store is one per process, so the checks run in the
 * order a server lives through: boot on nothing, boot on history, then runs.
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(44)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-usage-'));
const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const repo = createRepo(db, {
  name: 'usage-check', repoPath: join(root, 'repo'), worktreeRoot: join(root, 'worktrees'), defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
});
const card = createCard(db, { title: 'Uses the limits', repoId: repo.id, stage: 'planning' });
const run = insertRun(db, { id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'planning', status: 'succeeded', cwd: root });

const now = Date.now();
const HOUR = 60 * 60_000;
/** The stream's units: seconds. */
const secs = (ms: number) => Math.floor(ms / 1000);
const fiveHourReset = secs(now + 2 * HOUR);
const sevenDayReset = secs(now + 3 * 24 * HOUR);

/** A rate_limit_event the way a run sends it. */
function event(info: Record<string, unknown>) {
  return { type: 'rate_limit_event', rate_limit_info: info, uuid: crypto.randomUUID(), session_id: 'x' };
}
function unified(five: number, seven: number, extra: Record<string, unknown> = {}) {
  return event({
    status: five >= 0.9 ? 'allowed_warning' : 'allowed',
    rateLimitType: 'five_hour',
    utilization: five,
    resetsAt: fiveHourReset,
    isUsingOverage: false,
    surpassedThreshold: 0.9,
    unifiedWindows: {
      five_hour: { utilization: five, resetsAt: fiveHourReset },
      seven_day: { utilization: seven, resetsAt: sevenDayReset },
    },
    ...extra,
  });
}

let seq = 0;
function stored(kind: string, payload: unknown, at: number) {
  insertEvents(db, [{ runId: run.id, seq: ++seq, kind, sdkUuid: null, payload: JSON.stringify(payload), at: new Date(at) }]);
}

// --- boot, with nothing recorded: what API-key auth always looks like.
seedUsage(db);
check('no readings: null, not 0%', usageState(now) === null);

const board = apiRoutes(db, new EventWriter(db));
const body = async () => (await (await board.request('/board')).json()) as BoardResponse;
check('board carries usage: null', (await body()).usage === null);

// --- boot, with history: the newest row wins, whatever else is in the table.
stored(RATE_LIMIT_KIND, unified(0.41, 0.2), now - 30 * 60_000);
stored(RATE_LIMIT_KIND, unified(0.93, 0.23), now - 2 * 60_000);
stored('assistant', { type: 'assistant' }, now - 60_000);
seedUsage(db);
const seeded = usageState(now);
note('seeded', JSON.stringify(seeded));
check('seeded from the newest row', seeded?.fiveHour?.utilization === 0.93);
check('fractions stay fractions', seeded?.sevenDay?.utilization === 0.23);
check('resetsAt is epoch ms', seeded?.fiveHour?.resetsAt === fiveHourReset * 1000);
check('asOf is the row time', seeded?.asOf === now - 2 * 60_000);
check('5h takes the server status: warning', seeded?.fiveHour?.level === 'warning');
check('7d at 23% is ok', seeded?.sevenDay?.level === 'ok');
check('overall is the worse one', seeded?.level === 'warning');
check('board carries the same reading', (await body()).usage?.fiveHour?.utilization === 0.93);

// --- live runs.
recordRateLimit(unified(0.5, 0.1), now - 10 * 60_000);
check('an older reading is ignored', usageState(now)?.fiveHour?.utilization === 0.93);

recordRateLimit({ type: 'rate_limit_event', rate_limit_info: 'garbage' }, now);
recordRateLimit(null, now);
check('an unreadable payload is ignored', usageState(now)?.fiveHour?.utilization === 0.93);

recordRateLimit(
  event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: fiveHourReset }),
  now,
);
const fallback = usageState(now);
check('no unifiedWindows: top-level window used', fallback?.fiveHour?.utilization === 0.5);
check('and the other window is unknown', fallback?.sevenDay === null);
check('and it grades ok', fallback?.level === 'ok');

recordRateLimit(unified(0.4, 0.95), now + 1);
check('7d past the threshold: warning', usageState(now)?.sevenDay?.level === 'warning');
recordRateLimit(unified(0.4, 1), now + 2);
check('7d at 100%: rejected', usageState(now)?.sevenDay?.level === 'rejected');
check('overall follows it', usageState(now)?.level === 'rejected');

recordRateLimit(unified(1, 0.3, { status: 'rejected' }), now + 3);
const rejected = usageState(now);
check('5h rejected by the server', rejected?.fiveHour?.level === 'rejected' && rejected.level === 'rejected');

recordRateLimit(unified(0.97, 0.3, { status: 'allowed' }), now + 4);
check('the server’s own grade wins for its window', usageState(now)?.fiveHour?.level === 'ok');

recordRateLimit(unified(0.95, 0.3), now + 5);
const later = usageState(now + 3 * HOUR);
check('past its reset, 5h reads as started over', later?.fiveHour?.utilization === 0 && later.fiveHour.level === 'ok');
check('7d, not yet reset, is left alone', later?.sevenDay?.utilization === 0.3);
check('and nothing is left to warn about', later?.level === 'ok');

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? '\nSOME USAGE BEHAVIOURS FAILED' : '\nall usage behaviours verified');
