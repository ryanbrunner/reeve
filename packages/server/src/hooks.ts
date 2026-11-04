import { setTimeout as sleep } from 'node:timers/promises';
import type { Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { getCard, getSettings, listRepos } from './db/queries.js';
import type { Card } from './db/schema.js';
import { checkWorktree } from './git/worktree.js';
import { isOpeningPr } from './pullRequest.js';
import { startClaudeRun } from './runs/claude.js';
import type { EventWriter } from './runs/events.js';
import { stageHookTask, type HookMove } from './stages/hook.js';

/**
 * Settings' stage hooks: a prompt a person wrote, run as Claude whenever a
 * card enters or leaves a column, so that something outside Reeve — an issue
 * tracker, a channel — can follow the board without anyone copying it over.
 *
 * Fired by the places that change a card's column, after they have changed
 * it: a drag (the move route), an approval (`approveStage`), VIBES MODE's
 * `moveOn`, and a person making a card (the create route for one made with
 * its title, the discard route for one whose modal just closed). Not by
 * `moveCard` itself, which is a query with no writer and which the spikes
 * call to set a card up wherever they want it. A card Claude makes — a
 * suggestion, an idea, a project's split — fires nothing until it first
 * moves, and nor does archiving or restoring one: those are not a column.
 *
 * Fire-and-forget from the caller's side. Nothing a person does waits on a
 * hook, and a hook failing changes nothing on the board; its run is in the
 * card's history either way.
 */
export function fireStageHooks(db: Db, writer: EventWriter, card: Card, from: Stage | null, to: Stage): void {
  if (card.kind !== 'task' || from === to) return;
  const { stageHooks } = getSettings(db);
  const move: HookMove = {
    from,
    to,
    leave: from ? stageHooks[from].leave : null,
    enter: stageHooks[to].enter,
  };
  if (!move.leave && !move.enter) return;
  enqueue(card.id, () => runHook(db, writer, card.id, move));
}

/**
 * One card's hooks, in the order its moves happened. A card that VIBES MODE
 * takes from Backlog to In Progress and on to Testing inside a minute would
 * otherwise have its tracker told "Testing" and then "In Progress" whenever
 * the second run happened to finish first. In memory, so a restart loses
 * whatever was still waiting: the same trade `isStartingStage` makes.
 */
const queues = new Map<string, Promise<void>>();

function enqueue(cardId: string, job: () => Promise<void>): void {
  const run = (queues.get(cardId) ?? Promise.resolve()).then(job).catch((e) => {
    console.error(`[reeve] a stage hook for card ${cardId} failed to start: ${String(e)}`);
  });
  queues.set(cardId, run);
  void run.finally(() => {
    if (queues.get(cardId) === run) queues.delete(cardId);
  });
}

/**
 * Hook runs at once, across the whole board. Hooks are outside the
 * concurrency cap (see ClaudeTask.uncapped), but not unbounded: with the
 * board's switch on, one sweep moves every titled card in Backlog, and
 * fifteen of them would be fifteen Claude processes at once. Past this many,
 * a hook waits for a slot rather than being refused — waiting loses nothing,
 * where the cap's refusal would have lost it.
 */
const HOOK_SLOTS = 2;
let busy = 0;
const waiting: Array<() => void> = [];

async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  if (busy >= HOOK_SLOTS) await new Promise<void>((resolve) => waiting.push(resolve));
  else busy++;
  try {
    return await work();
  } finally {
    // Handed straight to the next in line, so `busy` never dips and lets a
    // newcomer in ahead of it.
    const next = waiting.shift();
    if (next) next();
    else busy--;
  }
}

/** How long a hook into Release waits for the pull request that arriving there opens. */
const PR_WAIT_MS = 3 * 60_000;
const PR_POLL_MS = 2_000;

async function runHook(db: Db, writer: EventWriter, cardId: string, move: HookMove): Promise<void> {
  // Arriving in Release opens the pull request, in the background. A hook
  // there is nearly always "link the pull request", so it waits for one
  // rather than telling the tracker there is none yet — before taking a
  // slot, so the wait holds up no other card's hook.
  if (move.to === 'release') {
    for (const end = Date.now() + PR_WAIT_MS; isOpeningPr(cardId) && Date.now() < end;) await sleep(PR_POLL_MS);
  }
  await inSlot(() => startHook(db, writer, cardId, move));
}

async function startHook(db: Db, writer: EventWriter, cardId: string, move: HookMove): Promise<void> {
  // Read again now: the card may have been given a branch, a pull request or
  // a new title since it moved, and the hook should say what is true.
  const card = getCard(db, cardId);
  if (!card) return;
  const repo = card.repoId ? listRepos(db).find((r) => r.id === card.repoId) : undefined;
  // Every run needs a directory to run in, and a card with no repo has none.
  if (!repo) return;
  // Its own worktree if that is there, the repo's checkout if not — Backlog
  // has no worktree, and the stage it just entered may still be making one.
  // The prompt tells it to change nothing in either.
  const health = await checkWorktree(repo.repoPath, card.worktreePath);
  const cwd = health.state === 'ok' ? health.path : repo.repoPath;
  const handle = startClaudeRun({
    db, writer, card, repo,
    stage: stageHookTask(move) as never,
    // Under the column it is about, even if the card has moved on again since.
    runStage: move.to,
    worktreePath: cwd,
  });
  await handle.done;
}
