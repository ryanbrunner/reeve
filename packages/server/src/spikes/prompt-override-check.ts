/**
 * Throwaway check on Settings' per-stage prompt override, with no API
 * credit: PATCH it in, build a stage's prompt off it, clear it, and compare
 * against the file Reeve ships.
 *
 *   REEVE_DB=/tmp/prompt-override.db npx tsx packages/server/src/spikes/prompt-override-check.ts
 */
import { rmSync } from 'node:fs';
import type { ApiSettings } from '@reeve/shared';
import { config } from '../config.js';
import { createCard, createRepo, getCard } from '../db/queries.js';
import { createApp } from '../index.js';
import { stageContextFor } from '../runs/claude.js';
import { planningStage } from '../stages/planning.js';
import { defaultPromptText } from '../stages/template.js';

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

const repo = createRepo(db, { name: 'prompt-override', repoPath: '/tmp/nowhere', worktreeRoot: '/tmp/nowhere-wt', defaultBranch: 'main' });
const card = createCard(db, { repoId: repo.id, title: 'A card', body: 'Do the thing.', stage: 'planning' });

const base = { card: getCard(db, card.id)!, repo, worktreePath: '/tmp/nowhere-wt/card' };

// No override set: the stage's prompt is exactly the shipped file, filled.
const plainCtx = stageContextFor(db, base, 'planning');
check('no override set: promptOverride is undefined', plainCtx.promptOverride === undefined);
const plainPrompt = planningStage.buildPrompt(plainCtx, {});
check('and the prompt is the shipped file, filled', plainPrompt.includes('A card') && plainPrompt.includes('/tmp/nowhere-wt/card'));

// An override, set through the real route: it reaches buildPrompt and its vars still fill.
const override = 'Custom instructions for {{title}} at {{worktreePath}}. Nothing else.';
const saved = await call('PATCH', '/api/settings', { stageDefaults: { planning: { model: null, effort: null, prompt: override } } });
check('Settings takes a prompt override', saved.status === 200 && (saved.json as ApiSettings).stageDefaults.planning.prompt === override, JSON.stringify(saved.json).slice(0, 200));

const overriddenCtx = stageContextFor(db, base, 'planning');
check('stageContextFor carries it as promptOverride', overriddenCtx.promptOverride === override);
const overriddenPrompt = planningStage.buildPrompt(overriddenCtx, {});
check('buildPrompt sends the override text with its vars filled', overriddenPrompt === 'Custom instructions for A card at /tmp/nowhere-wt/card. Nothing else.', overriddenPrompt);

// A blank save normalizes to null — never storing the default text itself.
const blanked = await call('PATCH', '/api/settings', { stageDefaults: { planning: { model: null, effort: null, prompt: '   ' } } });
check('a blank override is stored as null, not blank text', blanked.status === 200 && (blanked.json as ApiSettings).stageDefaults.planning.prompt === null, JSON.stringify((blanked.json as ApiSettings).stageDefaults.planning));

// Reset to default, by saving the shipped file's own text back: normalized to null too.
await call('PATCH', '/api/settings', { stageDefaults: { planning: { model: null, effort: null, prompt: override } } });
const reset = await call('PATCH', '/api/settings', { stageDefaults: { planning: { model: null, effort: null, prompt: defaultPromptText('planning') } } });
check('saving the file\'s own text back is also normalized to null', reset.status === 200 && (reset.json as ApiSettings).stageDefaults.planning.prompt === null, JSON.stringify((reset.json as ApiSettings).stageDefaults.planning));

// Cleared, a fresh run goes back to the shipped file, byte for byte.
const clearedCtx = stageContextFor(db, base, 'planning');
check('cleared: promptOverride is undefined again', clearedCtx.promptOverride === undefined);
const clearedPrompt = planningStage.buildPrompt(clearedCtx, {});
check('and the next run\'s prompt matches the file again, byte for byte', clearedPrompt === plainPrompt);

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
