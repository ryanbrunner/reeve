import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLACEHOLDER_PROJECT_TITLE, PLACEHOLDER_TITLE } from '@reeve/shared';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  addCriterion,
  addRef,
  archiveCard,
  cardEventsFor,
  createCard,
  createRepo,
  discardIfBlank,
  getCard,
  insertCardEvent,
  insertRun,
  updateCard,
} from '../db/queries.js';
import type { CardStage } from '../db/schema.js';

/**
 * What closing a card throws away, against a throwaway database: a card
 * nobody said anything about goes, and anything somebody did something with
 * stays.
 *
 *   npx tsx packages/server/src/spikes/discard-blank-check.ts
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(44)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-discard-'));
const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const makeRepo = (name: string) => createRepo(db, {
  name, repoPath: join(root, name), worktreeRoot: join(root, 'worktrees'), defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
});
const repo = makeRepo('discard-check');
const other = makeRepo('discard-check-other');

const task = (title = PLACEHOLDER_TITLE, extra: { stage?: CardStage; projectId?: string } = {}) =>
  createCard(db, { title, repoId: repo.id, stage: 'backlog', ...extra }).id;
const project = (title = PLACEHOLDER_PROJECT_TITLE) =>
  createCard(db, { title, kind: 'project', repoId: repo.id }).id;
const gone = (id: string) => getCard(db, id) === undefined;

// Thrown away.
const blank = task();
check('blank task is deleted', discardIfBlank(db, blank) && gone(blank));
check('and its story goes with it', cardEventsFor(db, blank).length === 0);

const blankProject = project();
check('blank project is deleted', discardIfBlank(db, blankProject) && gone(blankProject));
check('and its story goes with it', cardEventsFor(db, blankProject).length === 0);

const spaces = task();
updateCard(db, spaces, { body: '   \n ' });
check('whitespace-only brief is still blank', discardIfBlank(db, spaces) && gone(spaces));

const refiled = task();
updateCard(db, refiled, { repoId: other.id, model: 'opus', effort: 'high', generateMockups: false });
check('settings changed only is still blank', discardIfBlank(db, refiled) && gone(refiled));

// Kept.
const kept = (label: string, id: string) => check(label, !discardIfBlank(db, id) && !gone(id));

kept('titled task is kept', task('Fix the header'));

const briefed = task();
updateCard(db, briefed, { body: 'The header wraps on mobile.' });
kept('task with a brief is kept', briefed);

const criterion = task();
addCriterion(db, criterion, 'It fits on one line');
kept('task with a criterion is kept', criterion);

const reffed = task();
addRef(db, reffed, 'url', 'https://example.com');
kept('task with a reference is kept', reffed);

const noted = task();
insertCardEvent(db, { cardId: noted, actor: 'human', kind: 'note', stage: 'backlog', body: 'mind the logo' });
kept('task with a note is kept', noted);

const archived = task();
archiveCard(db, archived);
kept('archived blank task is kept', archived);

kept('blank task in Planning is kept', task(PLACEHOLDER_TITLE, { stage: 'planning' }));

const ran = task();
insertRun(db, { id: crypto.randomUUID(), cardId: ran, kind: 'claude', stage: 'backlog', status: 'failed', cwd: root });
kept('blank task with a run is kept', ran);

const briefedProject = project();
updateCard(db, briefedProject, { body: 'Rebuild onboarding.' });
kept('project with a brief is kept', briefedProject);

const parent = project();
task('A piece of it', { projectId: parent });
kept('blank project with a task is kept', parent);

const emptied = project();
archiveCard(db, task('Taken off', { projectId: emptied }));
kept('blank project with an archived task is kept', emptied);

// The placeholder is per kind: "Untitled" is a name for a project.
kept('project called Untitled is kept', project(PLACEHOLDER_TITLE));

check('unknown id is not deleted', !discardIfBlank(db, crypto.randomUUID()));

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? '\nSOME DISCARD BEHAVIOURS FAILED' : '\nall discard behaviours verified');
