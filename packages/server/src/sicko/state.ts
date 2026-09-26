import { STAGE_LABELS, type SickoState, type Stage } from '@reeve/shared';
import type { Db } from '../db/client.js';
import { getSettings, sickoLedger, tokensSince } from '../db/queries.js';

/** How many log lines the HUD is given. It shows two; the rest are headroom. */
const LOG_LINES = 4;

/**
 * SICKO MODE as the board should see it, or null while the switch is off.
 *
 * Every number is counted from the moment the switch was flipped, off the
 * cards' own event log. Nothing is tallied as it happens: the events already
 * are the record, so a reload cannot reset these and they cannot disagree with
 * what a card's history says happened to it.
 *
 * `humanApprovals` is counted rather than hardcoded to the zero it will almost
 * always be. The point of the number is that nobody was asked — but if someone
 * does walk over and approve a card by hand while this is on, the HUD should
 * say so rather than quietly claim otherwise.
 */
export function sickoState(db: Db): SickoState | null {
  const { sickoSince } = getSettings(db);
  if (sickoSince === null) return null;
  const since = new Date(sickoSince);
  const ledger = sickoLedger(db, since);

  const byClaude = (kind: string) =>
    ledger.filter((e) => e.kind === kind && e.actor === 'claude').length;

  return {
    since: sickoSince,
    merged: ledger.filter((e) => e.kind === 'merged').length,
    humanApprovals: ledger.filter((e) => e.kind === 'reviewed' && e.actor === 'human').length,
    reviewsSkipped: byClaude('reviewed'),
    questionsSelfAnswered: byClaude('answered'),
    spendTokens: tokensSince(db, since),
    moves: byClaude('moved'),
    log: ledger.flatMap((e) => {
      const line = logLine(e);
      return line ? [line] : [];
    }).slice(0, LOG_LINES),
  };
}

type Entry = ReturnType<typeof sickoLedger>[number];

/**
 * One event as a line of the HUD's log, or null for the ones not worth saying.
 *
 * Most of a card's history is noise at this altitude — a run starting, a
 * worktree appearing — and the log is two lines deep. What survives is what a
 * person watching would point at: something landed, something was waved
 * through, something broke and nothing stopped.
 */
function logLine(e: Entry): string | null {
  const it = `“${e.title}”`;
  const to = e.toStage ? STAGE_LABELS[e.toStage as Stage] : null;
  switch (e.kind) {
    case 'merged':
      return `Claude merged ${it} → main · 0 reviews`;
    case 'reviewed':
      return e.actor === 'claude'
        ? `Claude approved its own work on ${it} · nobody read it`
        : `You reviewed ${it}`;
    case 'answered':
      return e.actor === 'claude' ? `Claude answered its own question on ${it}` : null;
    case 'moved':
      return e.actor === 'claude' && to ? `${it} → ${to}` : null;
    case 'pr_opened':
      return `Pull request open on ${it} · merging it`;
    case 'pr_failed':
      return `Could not ship ${it} · ${e.body ?? 'no reason given'}`;
    case 'merge_failed':
      return `Could not merge ${it} · ${e.body ?? 'no reason given'}`;
    case 'run_finished': {
      const status = (e.meta as { status?: string } | null)?.status;
      return status === 'failed' || status === 'interrupted'
        ? `${status === 'failed' ? 'Error' : 'Interrupted'} on ${it} · ignored, moving on`
        : null;
    }
    default:
      return null;
  }
}
