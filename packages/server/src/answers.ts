import { isRunnable, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { answerQuestion, insertCardEvent, questionsForRun } from './db/queries.js';
import type { Card, CardEventActor, Question } from './db/schema.js';
import type { EventWriter } from './runs/events.js';
import { sendToCard } from './conversation.js';
import { renderPrompt } from './stages/template.js';

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
 * The answers go into the stage's conversation through `sendToCard`, the
 * same as anything else a person says: the session that asked is carried on
 * with them as its next message. Answering out of order is
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

  if (!isRunnable(card.stage as Stage)) return blocked('stage has no Claude work');

  // Into the conversation like anything else a person says: the run that
  // asked is the stage's last, and its session is the one carried on. Paired
  // with their questions, so Claude reads them as decided.
  const pairs = siblings.map((q) => `**${q.text}**\n${q.answer ?? ''}`).join('\n\n');
  const resumed = await sendToCard(db, writer, card, pairs, {
    actor,
    source: 'answer',
    prompt: renderPrompt('answers', { answers: pairs, submitTool: `submit_${card.stage}` }),
  });
  if (!resumed.ok) return blocked(resumed.detail ? `${resumed.error} (${resumed.detail})` : resumed.error);
  return { answered: siblings.length, of: siblings.length, resumed: resumed.runId };
}
