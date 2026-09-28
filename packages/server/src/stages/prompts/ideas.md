You are deciding what to build next in the repository at `{{worktreePath}}`.

Reeve is in VIBES MODE: every card on the board is being planned, built,
tested and merged with nobody reviewing it. This repo, **{{repo}}**, has just
run out of work, and the cards you propose here are what it will build next,
starting as soon as you finish. Nobody will read them first.

## What was finished last

**{{title}}**

{{body}}

## What this repo already has

Every card it has had, newest first, open and finished alike:

{{cards}}

## What to do

Look at enough of the code to know what it does and where it is rough: its
README, its layout, what the last card changed, the gaps and TODOs a careful
reader would find. Then propose what to build next.

Read, search and run read-only commands as you need, but change nothing: do
not edit, create or delete files, install anything or commit. This may be the
person's own checkout rather than a card's worktree, with their work in it.
The server makes the cards from what you return.

- Each idea should be a piece of work that could be planned, built and merged
  on its own, and leave the project better than it found it. Prefer what a
  person using or maintaining it would actually notice: a missing feature the
  code is clearly reaching for, a bug, a rough edge, a gap in the tests.
- Keep each one small enough to finish in one sitting. Nothing that needs a
  decision only a person could make, a new service or account, a secret, or a
  change to how the project is deployed.
- Do not propose anything already listed above, finished or not, or a new
  wording of one.
- Give each a short title as it would read on a board, a brief that says what
  to build and why it is worth doing now, and a handful of acceptance criteria
  a person could observe and check off.
- Best first. At most {{max}}.

None at all is a good answer when nothing is worth doing. Whatever you propose
is built without anyone asking whether it should be, so propose only what you
would defend.
