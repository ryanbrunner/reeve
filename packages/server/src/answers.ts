import { isRunnable, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import {
  answerQuestion,
  getRun,
  insertCardEvent,
  listRepos,
  questionsForRun,
} from './db/queries.js';
import type { Card, CardEventActor, Question } from './db/schema.js';
import type { EventWriter } from './runs/events.js';
import { stageDefinition } from './stages/index.js';
import { continueStage } from './startStage.js';

export interface AnswerResult {
  answered: number;
  of: number;
  /** The forked run the answers went to, or null if there are questions left. */
  resumed: string | null;
  /** Why the resume could not happen, when every question is answered and it still didn't. */
  blocked?: string;
}

/**
 * Record one answer, and when it was the last one, put Claude back to work.
 *
 * Out of the route for the same reason `approveStage` is: more than one thing
 * says it now. A person answering in the card modal and VIBES MODE answering
 * on their behalf must do exactly the same thing, and two copies of "and then
 * resume the run that asked" would drift apart the first time one of them grew
 * a step.
 *
 * The resume forks the session exactly as a rejection does: the attempt that
 * asked stays readable, and the answers arrive as prompt rather than as some
 * second channel Claude has to be taught about. Answering out of order is
 * fine — what matters is that none are left, not which came last.
 *
 * Anything that stops the resume is reported rather than thrown: the answer is
 * already saved, and losing it because the worktree went missing would be the
 * worse failure.
 */
export async function recordAnswer(
  db: Db,
  writer: EventWriter,
  card: Card,
  question: Question,
  answer: string,
  actor: CardEventActor = 'human',
): Promise<AnswerResult> {
  const answered = answerQuestion(db, question.id, answer.trim());
  insertCardEvent(db, {
    cardId: card.id, actor, kind: 'answered', stage: question.stage,
    runId: question.runId, body: answered.answer,
    meta: { question: question.text, position: question.position },
  });

  const siblings = question.runId ? questionsForRun(db, question.runId) : [];
  const pending = siblings.filter((q) => q.answer === null);
  if (pending.length > 0) {
    return { answered: siblings.length - pending.length, of: siblings.length, resumed: null };
  }

  const blocked = (detail: string): AnswerResult => ({
    answered: siblings.length, of: siblings.length, resumed: null, blocked: detail,
  });

  if (card.archivedAt) return blocked('card is archived');
  const repo = card.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
  if (!repo) return blocked('card has no repo');
  if (!isRunnable(card.stage as Stage)) return blocked('stage has no Claude work');
  const stage = stageDefinition(card.stage as never);
  if (!stage) return blocked('stage not implemented yet');

  // Fork the run that ASKED, not simply the latest one: those are the same
  // run today, and would quietly stop being so the moment anything else can
  // start one in between.
  const asked = question.runId ? getRun(db, question.runId) : null;

  // Waits for any setup the worktree is owed, the same as a revision: the run
  // that asked may have started in a tree whose setup failed.
  const resumed = await continueStage(db, writer, card, repo, {
    stage,
    answers: siblings.map((q) => ({ question: q.text, answer: q.answer ?? '' })),
    resumeSessionId: asked?.sessionId ?? null,
    parentRunId: asked?.id ?? null,
  });
  if (!resumed.ok) return blocked(resumed.error);
  return { answered: siblings.length, of: siblings.length, resumed: resumed.runId };
}
