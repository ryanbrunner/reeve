import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  branchNameFor, checkWorktree, commitsSince, createWorktree, diffSince, isDirty, listWorktrees, removeWorktree,
} from '../git/worktree.js';

const note = (l: string, v: unknown) => console.log(`${l.padEnd(26)}: ${v}`);
const root = mkdtempSync(join(tmpdir(), 'reeve-git-'));
const repo = join(root, 'repo');
const worktreeRoot = join(root, 'worktrees');
mkdirSync(repo); mkdirSync(worktreeRoot);

const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
writeFileSync(join(repo, 'README.md'), '# base\n');
g('add', '-A'); g('commit', '-qm', 'base');

const cardId = crypto.randomUUID();
note('branch name', branchNameFor(cardId, 'Wire the Planning stage end to end!!'));

const wt = await createWorktree({ repoPath: repo, worktreeRoot, cardId, title: 'Wire the Planning stage', base: 'main' });
note('worktree created', wt.path.replace(root, '…'));
note('base sha', wt.baseSha.slice(0, 8));
note('listed by git', (await listWorktrees(repo)).length + ' worktrees');
note('health', JSON.stringify(await checkWorktree(repo, wt.path)).replace(root, '…'));

// The decisive test: a committed change AND an uncommitted one.
writeFileSync(join(wt.path, 'committed.ts'), 'export const a = 1;\n');
execFileSync('git', ['-C', wt.path, 'add', '-A']);
execFileSync('git', ['-C', wt.path, 'commit', '-qm', 'add committed file']);
writeFileSync(join(wt.path, 'uncommitted.ts'), 'export const b = 2;\n');
execFileSync('git', ['-C', wt.path, 'add', '-A']); // staged but not committed

const diff = await diffSince(wt.path, wt.baseSha);
note('dirty', await isDirty(wt.path));
note('commits since base', JSON.stringify(await commitsSince(wt.path, wt.baseSha)));
note('diff covers committed', diff.includes('committed.ts'));
note('diff covers UNcommitted', diff.includes('uncommitted.ts'));

// Self-heal: delete the directory out from under the database, as a human would.
rmSync(wt.path, { recursive: true, force: true });
const health = await checkWorktree(repo, wt.path);
note('after manual delete', `${health.state}${health.state === 'missing' ? ` (${health.reason})` : ''}`);

await removeWorktree(repo, wt.path);
note('after remove', (await listWorktrees(repo)).length + ' worktrees remain');
note('health of null path', JSON.stringify(await checkWorktree(repo, null)));

rmSync(root, { recursive: true, force: true });
console.log('\nall worktree behaviours verified');
