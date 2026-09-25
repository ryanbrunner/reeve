import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { UsageLevel, UsageState, UsageWindow } from '@reeve/shared';
import type { Db } from './db/client.js';
import { runEvent } from './db/schema.js';

/** What `classify` in runs/claude.ts files these under. Renaming it there would hide every stored reading from the seed. */
const RATE_LIMIT_KIND = 'unknown:rate_limit_event';

/** Where the server's own warning starts when a reading does not say. It has always said 0.9 so far. */
const DEFAULT_THRESHOLD = 0.9;

// Fractions and epoch seconds, as the stream sends them.
const windowSchema = z.object({ utilization: z.number(), resetsAt: z.number() });

/**
 * The SDK types `rate_limit_info` without `unifiedWindows`, which is the only
 * place both windows arrive at once. Parsed for it anyway, with the top-level
 * fields — which describe the one window the reading is about — as the
 * fallback if it ever goes away.
 */
const messageSchema = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({
    status: z.string(),
    rateLimitType: z.string().optional(),
    utilization: z.number().optional(),
    resetsAt: z.number().optional(),
    surpassedThreshold: z.number().optional(),
    unifiedWindows: z
      .object({ five_hour: windowSchema.optional(), seven_day: windowSchema.optional() })
      .optional(),
  }),
});

type WindowKey = 'five_hour' | 'seven_day';

interface Reading {
  at: number;
  /** The server's own grade, which is only about `rateLimitType`'s window. */
  status: string;
  rateLimitType: string | null;
  threshold: number;
  windows: Partial<Record<WindowKey, z.infer<typeof windowSchema>>>;
}

/**
 * The newest reading, in memory. The board polls every second or so, and
 * `run_event` has no index on `kind`: asking the table each time would be a
 * full scan per poll for anyone on API-key auth, who has no such rows to find.
 */
let latest: Reading | null = null;

/**
 * Keeps a `rate_limit_event` if it is the newest seen. Called on the message
 * path of every run, so anything it cannot read is ignored rather than thrown:
 * a throw there would fail the run it arrived on.
 */
export function recordRateLimit(message: unknown, at: number): void {
  if (latest && at < latest.at) return;
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) return;
  const info = parsed.data.rate_limit_info;

  const windows: Reading['windows'] = {};
  if (
    (info.rateLimitType === 'five_hour' || info.rateLimitType === 'seven_day') &&
    info.utilization !== undefined &&
    info.resetsAt !== undefined
  ) {
    windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
  }
  Object.assign(windows, info.unifiedWindows);
  if (!windows.five_hour && !windows.seven_day) return;

  latest = {
    at,
    status: info.status,
    rateLimitType: info.rateLimitType ?? null,
    threshold: info.surpassedThreshold ?? DEFAULT_THRESHOLD,
    windows,
  };
}

/**
 * Picks up where the last process left off, so a restart does not blank the
 * readout until the next run speaks. One query, at boot, for the newest row.
 */
export function seedUsage(db: Db): void {
  const row = db
    .select({ payload: runEvent.payload, at: runEvent.at })
    .from(runEvent)
    .where(eq(runEvent.kind, RATE_LIMIT_KIND))
    .orderBy(desc(runEvent.at))
    .limit(1)
    .get();
  if (!row) return;
  try {
    recordRateLimit(JSON.parse(row.payload), row.at.getTime());
  } catch {
    // A payload that is not JSON is no reading at all; boot goes on without one.
  }
}

/** The newest reading as the board shows it, or null if no run has reported one. */
export function usageState(now: number): UsageState | null {
  if (!latest) return null;
  const fiveHour = grade(latest, 'five_hour', now);
  const sevenDay = grade(latest, 'seven_day', now);
  return {
    fiveHour,
    sevenDay,
    level: worst([fiveHour?.level, sevenDay?.level]),
    asOf: latest.at,
  };
}

/**
 * The window the reading is about takes the server's own verdict. The other
 * has none, so it is held to the same line the server warns at. Either one,
 * once its reset has passed, has started over — whatever it was left on.
 */
function grade(r: Reading, key: WindowKey, now: number): UsageWindow | null {
  const w = r.windows[key];
  if (!w) return null;
  const resetsAt = w.resetsAt * 1000;
  if (resetsAt <= now) return { utilization: 0, resetsAt, level: 'ok' };
  const level: UsageLevel =
    r.rateLimitType === key ? fromStatus(r.status)
    : w.utilization >= 1 ? 'rejected'
    : w.utilization >= r.threshold ? 'warning'
    : 'ok';
  return { utilization: w.utilization, resetsAt, level };
}

function fromStatus(status: string): UsageLevel {
  return status === 'rejected' ? 'rejected' : status === 'allowed_warning' ? 'warning' : 'ok';
}

function worst(levels: Array<UsageLevel | undefined>): UsageLevel {
  return levels.includes('rejected') ? 'rejected' : levels.includes('warning') ? 'warning' : 'ok';
}
