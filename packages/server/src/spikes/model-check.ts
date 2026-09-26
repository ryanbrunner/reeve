/**
 * Throwaway check: what the CLI says it offers, and the model and effort a run
 * would be started with for each layer of override — card, Settings, stage —
 * with Suggest shown ignoring all of them.
 *
 * Writes Settings defaults to prove they are read, and puts back whatever was
 * there before it exits.
 */
import { createApp } from '../index.js';
import { archiveCard, createCard, createRepo, getCard, getSettings, updateCard, updateSettings } from '../db/queries.js';
import { modelAndEffortFor } from '../runs/claude.js';
import { capabilitiesFor, listModels } from '../runs/models.js';
import { STAGE_DEFINITIONS } from '../stages/index.js';
import { suggestCriteriaTask } from '../stages/suggest_criteria.js';
import type { CardStage } from '../db/schema.js';
import type { ClaudeTask } from '../stages/types.js';

const { db } = createApp();

console.log('--- supportedModels() ---');
const models = await listModels();
if (models.length === 0) console.log('(none: the CLI could not be asked)');
for (const m of models) {
  const levels = m.supportsEffort === false ? 'no effort' : (m.supportedEffortLevels?.join('/') ?? 'effort unreported');
  const adaptive = m.supportsAdaptiveThinking === false ? 'no adaptive thinking' : 'adaptive thinking';
  console.log(`${m.value.padEnd(24)} ${m.displayName.padEnd(24)} ${levels} · ${adaptive}`);
}

console.log('\n--- what a pinned model would be sent ---');
for (const model of ['opus', 'sonnet', 'haiku']) {
  const caps = await capabilitiesFor(model);
  console.log(
    `${model.padEnd(8)} ${
      caps ?
        `effort ${caps.supportsEffort === false ? 'dropped' : 'kept'}, adaptive thinking ${caps.supportsAdaptiveThinking === false ? 'left out' : 'sent'}`
      : 'not listed: sent as asked'
    }`,
  );
}

const repo = createRepo(db, {
  name: `model-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});
const card = createCard(db, { title: 'probe', repoId: repo.id, stage: 'planning' });
const before = getSettings(db).stageDefaults;

const planning = STAGE_DEFINITIONS.planning!;
const inProgress = STAGE_DEFINITIONS.in_progress!;
const testing = STAGE_DEFINITIONS.testing!;

const cases: Array<[string, string, string]> = [];
function check(name: string, want: string, task: Pick<ClaudeTask, 'model' | 'effort' | 'outOfBand'>, runStage: CardStage) {
  const r = modelAndEffortFor(db, getCard(db, card.id)!, task, runStage);
  cases.push([name, `${r.model ?? 'null'} / ${r.effort ?? 'null'}`, want]);
}

try {
  const unset = { model: null, effort: null };
  updateSettings(db, { stageDefaults: { planning: unset, in_progress: unset, testing: unset } });
  check('nothing set, planning', 'null / high', planning, 'planning');
  check('nothing set, suggest', 'null / medium', suggestCriteriaTask, 'planning');

  updateSettings(db, { stageDefaults: { in_progress: { model: 'sonnet', effort: 'low' } } });
  check('settings default, in progress', 'sonnet / low', inProgress, 'in_progress');
  check('settings default is per stage', 'null / high', planning, 'planning');

  updateCard(db, card.id, { model: 'opus', effort: 'max' });
  check('card override beats settings', 'opus / max', inProgress, 'in_progress');
  check('card override, planning', 'opus / max', planning, 'planning');
  check('card override, testing', 'opus / max', testing, 'testing');
  check('card override, suggest ignores it', 'null / medium', suggestCriteriaTask, 'planning');

  updateCard(db, card.id, { model: 'opus', effort: null });
  check('card model only, effort from settings', 'opus / low', inProgress, 'in_progress');
  check('card model only, effort from stage', 'opus / high', planning, 'planning');
} finally {
  updateSettings(db, { stageDefaults: before });
  archiveCard(db, card.id);
}

console.log('\n--- resolution ---');
let failed = 0;
for (const [name, got, want] of cases) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}
console.log(failed === 0 ? '\nall resolution cases pass' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
