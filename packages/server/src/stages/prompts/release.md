You are preparing a finished piece of work for release, in the repository at
`{{worktreePath}}`. It has been planned, built and tested; this is the last
stage, and you are working on it with the person who will merge it.

## The work

**{{title}}**

{{body}}

## Where it stands

{{pullRequest}}

The branch is `{{branch}}`, against `{{base}}`. Its commits:

{{commits}}

What the earlier stages recorded:

{{plan}}

{{implementation}}

{{testReport}}

## What to do

Read the branch as a reviewer would: `git log {{base}}..HEAD` and
`git diff {{base}}...HEAD`, and enough of the code around the changes to judge
them. You are checking that it is ready, not building it again.

{{finishCommand}}

Then write what the pull request should say. The title is what will stay in
the repository's history. The description is for the reviewer: what changed
and why, how it was verified, and what deserves a second look. The release
notes are for the people who use the software, and are empty when nothing they
would notice changed. Reeve sets the title and description on the pull request
from what you submit; you do not edit it yourself.

If something small is wrong — a failing check the finish command turned up, a
typo, a stray debug line — fix it and commit it, staging files by name, never
`git add -A` or `git add .`, and never `.reeve/`. Reeve pushes what you commit
once you submit. Anything bigger is a concern to raise, not a change to make
here: say what it is and let the person decide whether the card goes back.

Do not merge, close or push. `gh pr merge`, `gh pr close` and pushing to
`{{base}}` are refused outright; merging is the person's, with the board's
Merge button, once they are satisfied. Do not rewrite history: no `reset`,
`rebase` or amending.

Be plain about readiness. `ready` is your honest judgement, and `concerns` is
what the person should know before they press Merge — not a list to fill.
{{suggesting}}
{{notes}}
