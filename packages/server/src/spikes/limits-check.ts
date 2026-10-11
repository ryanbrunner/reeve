/**
 * Throwaway check on run limits, with no API credit: Settings' per-stage
 * budget and turns, a card's own above them, what a run is actually sent, and
 * how a run its limit stopped reads on the board.
 *
 *   REEVE_DB=/tmp/limits.db npx tsx packages/server/src/spikes/limits-check.ts
 */
import { rmSync } from 'node:fs';
import type { ApiCard, ApiSettings, BoardResponse } from '@reeve/shared';
import { config } from '../config.js';
import { createCard, createRepo, getCard, insertRun } from '../db/queries.js';
import { createApp } from '../index.js';
import { limitsFor } from '../runs/claude.js';
import { inProgressStage } from '../stages/in_progress.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const { app, db } = createApp();
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => null)) as never };
};

const repo = createRepo(db, { name: 'limits', repoPath: '/tmp/nowhere', worktreeRoot: '/tmp/nowhere-wt', defaultBranch: 'main' });
const card = createCard(db, { repoId: repo.id, title: 'Big card', body: '', stage: 'in_progress' });

// Stage defaults alone.
const plain = limitsFor(db, getCard(db, card.id)!, inProgressStage, 'in_progress');
check('a card with nothing set gets the stage module\'s limits', plain.budgetUsd === inProgressStage.maxBudgetUsd && plain.maxTurns === inProgressStage.maxTurns, JSON.stringify(plain));

// Settings.
const saved = await call('PATCH', '/api/settings', { stageDefaults: { in_progress: { model: null, effort: null, maxBudgetUsd: 20, maxTurns: 300 } } });
check('Settings takes a stage\'s limits', saved.status === 200 && (saved.json as ApiSettings).stageDefaults.in_progress.maxBudgetUsd === 20, JSON.stringify(saved.json).slice(0, 200));
const modelOnly = await call('PATCH', '/api/settings', { stageDefaults: { in_progress: { model: 'sonnet', effort: null } } });
const after = (modelOnly.json as ApiSettings).stageDefaults.in_progress;
check('saving only a model leaves the limits alone', after.maxBudgetUsd === 20 && after.maxTurns === 300 && after.model === 'sonnet', JSON.stringify(after));
const fromSettings = limitsFor(db, getCard(db, card.id)!, inProgressStage, 'in_progress');
check('a run is sent the Settings limits', fromSettings.budgetUsd === 20 && fromSettings.maxTurns === 300, JSON.stringify(fromSettings));
const tooBig = await call('PATCH', '/api/settings', { stageDefaults: { in_progress: { model: null, effort: null, maxBudgetUsd: 5000 } } });
check('a budget past $1,000 is refused', tooBig.status === 400, String(tooBig.status));

// The card's own.
const patched = await call('PATCH', `/api/cards/${card.id}`, { maxBudgetUsd: 35, maxTurns: 500 });
check('a card takes its own limits', patched.status === 200 && (patched.json as ApiCard).maxBudgetUsd === 35, JSON.stringify(patched.json).slice(0, 120));
const fromCard = limitsFor(db, getCard(db, card.id)!, inProgressStage, 'in_progress');
check('and they win over Settings', fromCard.budgetUsd === 35 && fromCard.maxTurns === 500, JSON.stringify(fromCard));
const badTurns = await call('PATCH', `/api/cards/${card.id}`, { maxTurns: 2.5 });
check('a fractional turn limit is refused', badTurns.status === 400, String(badTurns.status));
await call('PATCH', `/api/cards/${card.id}`, { maxBudgetUsd: null, maxTurns: null });
const cleared = limitsFor(db, getCard(db, card.id)!, inProgressStage, 'in_progress');
check('cleared, the card falls back to Settings', cleared.budgetUsd === 20 && cleared.maxTurns === 300, JSON.stringify(cleared));

// A run its budget stopped.
insertRun(db, {
  id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'in_progress', status: 'failed', stopReason: 'budget_exhausted',
  sessionId: crypto.randomUUID(), prompt: 'p', cwd: '/tmp/nowhere-wt', startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
  maxBudgetUsd: 20, totalCostUsd: 20.14,
});
const board = (await call('GET', '/api/board')).json as BoardResponse;
const face = board.cards.find((c) => c.id === card.id);
check('a run stopped at its budget reads as waiting on the person', face?.activity === 'needs_input', face?.activity);
check('and says why on the board', /Stopped at its \$20\.00 budget/.test(face?.waitingOn ?? ''), face?.waitingOn ?? 'nothing');
check('with what it spent and was allowed', face?.latestRun?.totalCostUsd === 20.14 && face.latestRun.budgetUsd === 20, JSON.stringify(face?.latestRun).slice(0, 160));

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
