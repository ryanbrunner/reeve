/**
 * What a stage's shell is, said once.
 *
 * Grouped by capability rather than by stage, so a stage's `allowedTools` reads
 * as the things it needs to be able to do — and two stages cannot drift into
 * different spellings of "can read git history". They had: In Progress could
 * run `git show`, Planning could not, for no reason either file recorded.
 *
 * Every entry is a PREFIX, matched against the whole command. `git -C <path>
 * log` is therefore not `Bash(git log *)`, however much it looks like one, and
 * neither is a compound command whose second half is something else. Both are
 * forms a run reaches for constantly; runs/permissions.ts is what answers them.
 */

/** Reading history and state. Nothing here changes a byte. */
export const GIT_READ = [
  'Bash(git status *)', 'Bash(git log *)', 'Bash(git diff *)', 'Bash(git show *)',
  'Bash(git branch *)', 'Bash(git merge-base *)', 'Bash(git rev-parse *)', 'Bash(git ls-files *)',
];

/**
 * Committing the stage's own work — and nothing else. No `push`, no `reset`, no
 * `rebase`: the worktree is the blast radius, and history the run did not write
 * is outside it.
 */
export const GIT_COMMIT = ['Bash(git add *)', 'Bash(git commit *)'];

/** Building and testing through the repo's own scripts. */
export const NODE_TOOLING = ['Bash(npm run *)', 'Bash(npm test *)', 'Bash(npx *)', 'Bash(node *)'];
