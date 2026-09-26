import { STAGE_LABELS, canStartRun, type ApiCard, type CardActivity } from '@reeve/shared';
import { api } from './client.js';
import { cardRef, note } from './output.js';

/**
 * What a card entering a column set off, said once it has happened rather
 * than predicted. A move is a human action, and in Reeve a human action is
 * what starts Claude and opens pull requests — so a command that causes one
 * has to say which, not leave a script to find out from the bill.
 *
 * Both are started by the server without waiting on them: making a worktree
 * and pushing a branch take seconds, and a drag must not hang on either. The
 * move's own response therefore cannot say how it went, and these watch the
 * card for a while instead. Everything they say goes to stderr.
 */

/** Long enough to make a worktree and push a branch; short enough that a script is not left hanging. */
const WATCH_MS = 20_000;
const POLL_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The board's copy of a card, which unlike the move's response carries its repo's name. */
export async function refetch(card: ApiCard): Promise<ApiCard> {
  return (await api.board()).cards.find((c) => c.id === card.id) ?? card;
}

/** The ids of every run the card has had, to tell a new one from them afterwards. */
export async function runIds(cardId: string): Promise<Set<string>> {
  return new Set((await api.runs(cardId)).map((r) => r.id));
}

/** Why a card that entered a runnable column was not started: `canStartRun`'s reasons, in words. */
const HELD: Partial<Record<CardActivity, string>> = {
  running: 'a run is already going there',
  needs_review: 'its last run there is waiting on your review',
  needs_input: 'its last run there is waiting on answers to its questions',
};

/**
 * A card in Planning, In Progress or Testing, just made or moved there. The
 * server starts its stage when `maybeStartStage` would, and this says whether
 * it did: a new Claude run for that stage among the card's runs.
 */
export async function watchStart(card: ApiCard, before: Set<string>): Promise<ApiCard> {
  const stage = STAGE_LABELS[card.stage];
  const label = cardRef(card);
  if (!card.repoId) {
    note(`No ${stage} run: ${label} has no repo for Claude to work in. Give it one with \`reeve card edit --repo\`.`);
    return card;
  }
  if (!canStartRun(card)) {
    note(`No ${stage} run: ${HELD[card.activity] ?? card.activity}.`);
    return card;
  }
  note(`${stage} runs Claude: starting a run for ${label}…`);
  const deadline = Date.now() + WATCH_MS;
  while (Date.now() < deadline) {
    const run = (await api.runs(card.id)).find(
      (r) => r.kind === 'claude' && r.task === null && r.stage === card.stage && !before.has(r.id),
    );
    if (run) {
      note(`Started ${label}'s ${stage} run: ${run.id}`);
      return refetch(card);
    }
    await sleep(POLL_MS);
  }
  // Refusals are not recorded anywhere a client can read: the card is left
  // idle with its Run button, and the server logs why.
  note(
    `No ${stage} run has appeared yet. Reeve may still be making the worktree, or it refused — ` +
      `at the concurrency limit, say. The server's log says which; the card keeps its Run button either way.`,
  );
  return refetch(card);
}

/**
 * A card just moved into Done. `openingPr` is set before the move answers,
 * so it says at once whether a push began; this then waits to see it land.
 */
export async function watchPullRequest(card: ApiCard): Promise<ApiCard> {
  const label = cardRef(card);
  if (!card.openingPr) {
    if (card.mergedAt) note(`${label} is already merged, so there is no pull request to open.`);
    else if (!card.repoId || !card.worktreePath) note(`No pull request: ${label} has no branch to push.`);
    else note(`Reeve did not start a pull request for ${label}; the card says why if something went wrong.`);
    return card;
  }
  note(`Done opens a pull request: pushing ${label}'s branch…`);
  const deadline = Date.now() + WATCH_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const now = await refetch(card);
    if (now.openingPr) continue;
    if (now.prUrl) {
      note(`Pull request for ${label}: ${now.prUrl}`);
    } else {
      // A failure is recorded as an event on the card. Events come newest
      // first, so the latest word on a pull request is the first one found.
      const last = (await api.detail(card.id)).events.find((e) => e.kind === 'pr_failed' || e.kind === 'pr_opened');
      note(`The pull request was not opened${last?.kind === 'pr_failed' && last.body ? `: ${last.body}` : '.'}`);
    }
    return now;
  }
  note(`Still pushing ${label}'s branch. The card shows the pull request once GitHub has it.`);
  return refetch(card);
}
