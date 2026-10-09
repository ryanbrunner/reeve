import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ApiCard, ApiRepo, BoardResponse } from '@reeve/shared';
import { CliError } from './output.js';
import { appendIndex, isWithin, parseStage, requireStage, resolveCard, whereAmI, type Here } from './resolve.js';

function repo(id: string, name: string, repoPath: string): ApiRepo {
  return {
    id,
    name,
    repoPath,
    worktreeRoot: join(repoPath, '..', '.reeve-worktrees'),
    defaultBranch: 'main',
    setupCommand: null,
    testCommand: null,
    seedCommand: null,
    serverCommand: null,
    serverUrl: null,
    teardownCommand: null,
    finishCommand: null,
    laneColor: null,
    syncDefaultBranch: false,
  };
}

function card(values: Partial<ApiCard> & Pick<ApiCard, 'id' | 'number'>): ApiCard {
  return {
    kind: 'task',
    projectId: null,
    repoId: null,
    repoName: null,
    laneColor: null,
    title: `Card ${values.number}`,
    body: '',
    stage: 'backlog',
    position: 0,
    branchName: null,
    worktreePath: null,
    mergedSha: null,
    mergedAt: null,
    prUrl: null,
    prNumber: null,
    prOpenedAt: null,
    openingPr: false,
    prConflicting: false,
    prMergeable: false,
    resolvingConflicts: false,
    mergingPr: false,
    startingStage: false,
    implemented: false,
    vibes: false,
    dependsOn: [],
    dependents: [],
    suggestedBy: null,
    suggestions: [],
    pendingSuggestion: false,
    waitingOn: null,
    model: null,
    effort: null,
    generateMockups: false,
    activity: 'idle',
    latestRun: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...values,
  };
}

const alpha = repo('r-alpha', 'alpha', '/code/alpha');
const beta = repo('r-beta', 'beta', '/code/beta');
const inAlpha = { repoId: alpha.id, repoName: alpha.name };
const inBeta = { repoId: beta.id, repoName: beta.name };

const board: BoardResponse = {
  repos: [alpha, beta],
  projects: [],
  vibes: null,
  usage: null,
  cards: [
    card({ id: 'aaaa1111-0000-4000-8000-000000000001', number: 12, ...inAlpha, stage: 'planning' }),
    card({ id: 'bbbb2222-0000-4000-8000-000000000002', number: 12, ...inBeta }),
    card({
      id: 'aaaa3333-0000-4000-8000-000000000003',
      number: 7,
      ...inAlpha,
      stage: 'in_progress',
      worktreePath: '/code/.reeve-worktrees/alpha-7',
    }),
    card({ id: 'cccc4444-0000-4000-8000-000000000004', number: 8, ...inBeta, stage: 'in_progress' }),
  ],
};

const identity = (path: string) => path;
const nowhere: Here = { card: null, repo: null };
const at = (cwd: string) => whereAmI(board, cwd, identity);

describe('parseStage', () => {
  test('accepts the id, a hyphenated id and the label', () => {
    for (const input of ['in_progress', 'in-progress', 'In Progress', 'IN-PROGRESS', ' in progress ']) {
      assert.equal(parseStage(input), 'in_progress', input);
    }
    assert.equal(parseStage('Backlog'), 'backlog');
  });

  test('takes Done, the old name of Release', () => {
    for (const input of ['done', 'Done', 'release', 'Release']) assert.equal(parseStage(input), 'release', input);
  });

  test('rejects anything else, as a usage error', () => {
    assert.equal(parseStage('doing'), null);
    assert.throws(() => requireStage('doing'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  });
});

describe('isWithin', () => {
  test('matches the directory and what is under it', () => {
    assert.ok(isWithin('/code/reeve', '/code/reeve'));
    assert.ok(isWithin('/code/reeve/src', '/code/reeve'));
    assert.ok(isWithin('/code/reeve/src', '/code/reeve/'));
  });

  test('only on a segment boundary', () => {
    assert.ok(!isWithin('/code/reeve-other', '/code/reeve'));
    assert.ok(!isWithin('/code', '/code/reeve'));
  });
});

describe('whereAmI', () => {
  test('a worktree is its card, and its repo is the card’s', () => {
    const here = at('/code/.reeve-worktrees/alpha-7/packages/web');
    assert.equal(here.card?.number, 7);
    assert.equal(here.repo?.name, 'alpha');
  });

  test('inside a repo there is a repo and no card', () => {
    const here = at('/code/beta/src');
    assert.equal(here.card, null);
    assert.equal(here.repo?.name, 'beta');
  });

  test('a sibling directory sharing a prefix is not the repo', () => {
    assert.deepEqual(at('/code/alpha-other'), nowhere);
  });

  test('both sides are compared by their real paths', (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'reeve-cli-'));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    mkdirSync(join(tmp, 'real', 'wt', 'src'), { recursive: true });
    symlinkSync(join(tmp, 'real'), join(tmp, 'link'));

    const linked: BoardResponse = {
      repos: [alpha],
      projects: [],
      vibes: null,
      usage: null,
      cards: [card({ id: 'dddd', number: 3, ...inAlpha, worktreePath: join(tmp, 'real', 'wt') })],
    };
    assert.equal(whereAmI(linked, join(tmp, 'link', 'wt', 'src')).card?.number, 3);
  });
});

describe('resolveCard', () => {
  const resolve = (ref: string, here = nowhere) => resolveCard(board, ref, here).id;

  test('a bare number is looked up in the repo the cwd is in', () => {
    assert.equal(resolve('12', at('/code/beta')), board.cards[1]!.id);
    assert.equal(resolve('#12', at('/code/.reeve-worktrees/alpha-7')), board.cards[0]!.id);
  });

  test('and not in other repos when the cwd names one', () => {
    assert.throws(() => resolve('8', at('/code/alpha')), /no card #8 in alpha/);
  });

  test('outside any repo it is looked up everywhere', () => {
    assert.equal(resolve('#7'), board.cards[2]!.id);
  });

  test('ambiguity is an error naming the candidates', () => {
    assert.throws(() => resolve('12'), (e: unknown) => {
      assert.ok(e instanceof CliError);
      assert.match(e.message, /alpha#12/);
      assert.match(e.message, /beta#12/);
      return true;
    });
  });

  test('repo#n names the repo', () => {
    assert.equal(resolve('beta#12'), board.cards[1]!.id);
    assert.equal(resolve('Alpha#12'), board.cards[0]!.id);
    assert.throws(() => resolve('gamma#12'), /no repo called 'gamma'/);
    assert.throws(() => resolve('beta#7'), /no card on the board/);
  });

  test('an id or an unambiguous prefix of one', () => {
    assert.equal(resolve('cccc4444-0000-4000-8000-000000000004'), board.cards[3]!.id);
    assert.equal(resolve('BBBB'), board.cards[1]!.id);
    assert.throws(() => resolve('aaaa'), /matches more than one card/);
  });

  test('anything else is a usage error', () => {
    assert.throws(() => resolve('not a card'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  });
});

describe('appendIndex', () => {
  test('is the column’s length for a card joining it', () => {
    assert.equal(appendIndex(board, board.cards[0]!.id, 'in_progress'), 2);
    assert.equal(appendIndex(board, board.cards[0]!.id, 'release'), 0);
  });

  test('does not count the card itself when it is already there', () => {
    assert.equal(appendIndex(board, board.cards[2]!.id, 'in_progress'), 1);
  });
});
