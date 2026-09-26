/**
 * Throwaway: a board with a card in every state, switched into SICKO MODE, for
 * eyeballing the lights.
 *
 * Point it at a scratch database, because SICKO MODE moves real cards:
 *
 *   REEVE_DB=/tmp/sicko.db tsx src/spikes/seed-sicko-board.ts
 *   REEVE_DB=/tmp/sicko.db REEVE_SICKO_SWEEP_MS=3600000 REEVE_PORT=4399 npm start
 *
 * The long sweep interval is the point of the second line: it leaves the board
 * holding still in every state at once, which is what you want to look at. Drop
 * it and the sweep starts emptying the columns, which is what you want to watch.
 */
import { eq } from 'drizzle-orm';
import { createApp } from '../index.js';
import { createCard, createRepo, insertRun, replaceQuestions, setRunStatus, updateSettings } from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import type { Stage } from '@reeve/shared';

const { db } = createApp();

const repo = createRepo(db, {
  name: 'storefront', repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b7db3', maxBudgetUsd: null,
});

/** The real planning shape: `awaitsInput` parses this, and a near-miss reads as review. */
const PLAN = {
  summary: 'An approach', details: [], steps: [], open_questions: [],
  acceptance_criteria: [], captures: [], files_to_touch: [], risk: 'low',
};

const ASKS = {
  ...PLAN,
  open_questions: [{ question: 'Per IP or per account?', suggestions: ['Per account', 'Per IP'] }],
};

type Face = 'idle' | 'running' | 'review' | 'input' | 'error' | 'merged';

function card(title: string, stage: Stage, face: Face, cost?: number) {
  const c = createCard(db, { title, repoId: repo.id, stage });
  if (face === 'merged') {
    db.update(cardTable)
      .set({ mergedAt: new Date(), prUrl: 'https://example.invalid/pull/1', prNumber: 1 })
      .where(eq(cardTable.id, c.id))
      .run();
  }
  if (cost === undefined) return;
  // Backlog and Done have no runs of their own, so the cost a card carries out
  // of them belongs to the last stage that did run.
  const runStage = stage === 'backlog' || stage === 'done' ? 'planning' : stage;
  const r = insertRun(db, {
    id: crypto.randomUUID(), cardId: c.id, kind: 'claude', stage: runStage, status: 'running', cwd: '/tmp/x',
  });
  const status =
    face === 'running' ? 'running'
    : face === 'error' ? 'failed'
    : face === 'review' || face === 'input' ? 'succeeded'
    : 'cancelled';
  setRunStatus(db, r.id, {
    status,
    totalCostUsd: cost,
    structuredOutput: face === 'input' ? ASKS : PLAN,
    startedAt: new Date(),
    finishedAt: status === 'running' ? null : new Date(),
  });
  if (face === 'input') {
    replaceQuestions(db, c.id, r.id, runStage, [
      { question: 'Per IP or per account?', suggestions: ['Per account', 'Per IP'] },
    ]);
  }
}

card('Gift notes at checkout', 'backlog', 'idle');
card('Size guide drawer on product pages', 'backlog', 'idle');
card('Filter order history by status', 'backlog', 'idle');
// Planning keeps only a card left over from before the switch, asking a
// question: SICKO MODE never starts a plan, so the sign under it has to show.
card('Rate-limit the checkout API', 'planning', 'input', 0.012);
card('Reorder from a past order', 'in_progress', 'running', 0.031);
card('Email me when it’s back in stock', 'in_progress', 'running', 0.048);
card('Fix tax rounding on refunds', 'in_progress', 'error', 0.009);
card('Rewrite checkout in Rust', 'in_progress', 'running', 0.096);
card('Save items for later from the cart', 'testing', 'review', 0.184);
card('Migrate the database, live', 'testing', 'review', 0.141);
card('Cart page redesign', 'done', 'merged', 0.212);
card('Apple Pay on mobile', 'done', 'merged', 0.141);
card('Make the logo bigger', 'done', 'idle', 0.09);

updateSettings(db, { sicko: true });
console.log('seeded, and SICKO MODE is on');
process.exit(0);
