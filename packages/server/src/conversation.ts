import { isRunnable, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { getSettings, insertCardEvent, latestClaudeRunForStage, liveStageRun, listRepos, unreadNotesFor } from './db/queries.js';
import type { Card, CardEventActor, Repo } from './db/schema.js';
import { answerFromText, askRegistry, type AskAnswer } from './runs/asks.js';
import type { MessageSource } from './runs/claude.js';
import type { EventWriter } from './runs/events.js';
import { runRegistry } from './runs/registry.js';
import { renderNotes } from './stages/template.js';
import { stageDefinition } from './stages/index.js';
import { continueStage, isStartingStage, startStage } from './startStage.js';

/**
 * Talking to Claude about a card.
 *
 * Every way a person's words reach a stage comes through `sendToCard`: the
 * composer, `reeve card reply`, answering a plan's questions, sending a stage
 * back, a note left while Claude works, a round of comments in Crit or Gloss,
 * and VIBES MODE replying for nobody. Before this they were four mechanisms,
 * each its own forked run with its own prompt template, and nothing could
 * reach a run while it worked.
 *
 * Where it goes depends only on the card's run:
 *
 * - **Parked on a person** (`asking`): the words answer what it asked — their
 *   own answer to its question, or a refusal with their reason.
 * - **Live**: pushed into the session, where Claude reads it at the next tool
 *   boundary — or, if the turn has just ended, as the next one.
 * - **Otherwise**: the stage's last session is forked with the message as its
 *   prompt, the same fork a rejection always made. Nothing is kept running
 *   between turns, so a card waiting on a person holds no process and no slot.
 * - **No session yet** in this column: the stage starts, and the message is
 *   left as a note, which its prompt carries.
 */

export interface SendOptions {
  actor?: CardEventActor;
  source?: MessageSource;
  /**
   * What Claude reads, when it should not be the words exactly as the person
   * wrote them: a rejection is framed as one, answers are paired with the
   * questions they answer. The conversation still shows `text`.
   */
  prompt?: string;
}

export type SendResult =
  | {
      ok: true;
      delivered: 'answered' | 'live' | 'resumed' | 'started';
      runId: string;
      /** Settles when a resumed or started run finishes, for a caller with something to do then. */
      done?: Promise<void>;
    }
  | { ok: false; status: 400 | 409 | 429 | 501; error: string; detail?: string };

export async function sendToCard(db: Db, writer: EventWriter, card: Card, text: string, opts: SendOptions = {}): Promise<SendResult> {
  const words = text.trim();
  if (!words) return { ok: false, status: 400, error: 'nothing to send' };
  const actor = opts.actor ?? 'human';
  const source = opts.source ?? 'chat';
  if (card.archivedAt) return { ok: false, status: 409, error: 'card is archived' };
  if (card.kind === 'project') return { ok: false, status: 400, error: 'a project has no conversation', detail: 'split it into tasks' };

  const live = liveStageRun(db, card.id);
  if (live) {
    const ask = askRegistry.forRun(live.id);
    if (ask) {
      writer.append(live.id, 'user_message', { text: words, actor, source, live: true, at: Date.now() });
      askRegistry.settle(ask.id, answerFromText(ask, words, actor));
      return { ok: true, delivered: 'answered', runId: live.id };
    }
    const active = runRegistry.get(live.id);
    if (active?.send?.(opts.prompt ?? words)) {
      writer.append(live.id, 'user_message', { text: words, actor, source, live: true, at: Date.now() });
      return { ok: true, delivered: 'live', runId: live.id };
    }
    // Live but not listening: still preparing (Testing photographing the
    // build), stopping, or a turn that ended in the instant before this.
    // The last of those is gone in a moment, so it is waited out; the rest are
    // refused with what to do.
    const settled = await settles(db, card.id, live.id, 3_000);
    if (!settled) {
      return {
        ok: false, status: 409, error: 'Claude is not listening yet',
        detail: active ? 'the run is still getting ready; send it again in a moment' : 'the run is starting',
      };
    }
  }

  if (!isRunnable(card.stage as Stage)) {
    return { ok: false, status: 409, error: `there is no conversation in ${card.stage}`, detail: 'move the card to a stage Claude works in' };
  }
  const stage = stageDefinition(card.stage as never);
  if (!stage) return { ok: false, status: 501, error: 'stage not implemented yet' };
  const repo = repoFor(db, card);
  if (!repo) return { ok: false, status: 409, error: 'card has no repo' };
  if (isStartingStage(card.id)) return { ok: false, status: 409, error: 'the stage is already starting', detail: 'send it again once Claude is working' };

  // Read on every send, as `startStage` does: a reply is a run like any other.
  const { maxConcurrentRuns } = getSettings(db);
  if (runRegistry.countByKind('claude') >= maxConcurrentRuns) {
    return { ok: false, status: 429, error: 'too many concurrent runs', detail: `limit is ${maxConcurrentRuns}; send it again when one finishes` };
  }

  const last = latestClaudeRunForStage(db, card.id, card.stage);
  if (!last?.sessionId) {
    // Nothing to fork in this column: start the stage, with the words as a
    // note its prompt already knows how to carry.
    insertCardEvent(db, { cardId: card.id, actor, kind: 'note', stage: card.stage, body: words, meta: { source } });
    const started = await startStage(db, writer, card, repo, { userMessage: { text: words, actor, source } });
    if (!started.ok) return { ok: false, status: started.status === 500 ? 409 : (started.status as 400 | 409 | 429 | 501), error: started.error, detail: started.detail };
    return { ok: true, delivered: 'started', runId: started.runId };
  }

  // Notes left since the last run ride along, as they always reached the next run.
  const notes = renderNotes(unreadNotesFor(db, card.id));
  const resumed = await continueStage(db, writer, card, repo, {
    stage,
    followUp: [opts.prompt ?? words, notes].filter((s) => s.trim()).join('\n\n'),
    userMessage: { text: words, actor, source },
    resumeSessionId: last.sessionId,
    parentRunId: last.id,
  });
  if (!resumed.ok) return { ok: false, status: 409, error: resumed.error };
  return { ok: true, delivered: 'resumed', runId: resumed.runId, done: resumed.done };
}

/**
 * Answer what a live run is parked on, from the card's buttons: Allow once,
 * Deny, or a choice among a question's options. False when it is no longer
 * waiting — answered elsewhere, timed out, or stopped.
 */
export function answerAsk(card: Card, askId: string, answer: Exclude<AskAnswer, { kind: 'unanswered' }>): boolean {
  const ask = askRegistry.forCard(card.id);
  if (!ask || ask.id !== askId || ask.kind !== answer.kind) return false;
  return askRegistry.settle(askId, answer);
}

/** Whether the live run is gone within `ms`. */
async function settles(db: Db, cardId: string, runId: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (liveStageRun(db, cardId)?.id !== runId) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function repoFor(db: Db, card: Card): Repo | undefined {
  return card.repoId ? listRepos(db).find((r) => r.id === card.repoId) : undefined;
}
