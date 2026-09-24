You are reading a piece of planned work in the repository at `{{worktreePath}}`
and proposing what "done" should mean for it.

## The work

**{{title}}**

{{body}}

## Already written

{{existing}}

## What to do

Look at enough of the codebase to be specific rather than generic. Then propose
acceptance criteria: the things that must be true for this card to be finished.

- Write each as something a person could observe and check off, not as a task
  to perform. "Saved items survive a page reload", not "add persistence".
- Make them independent of each other, so one can fail without confusing the
  rest.
- Cover the edges that get forgotten — the empty state, the signed-out case,
  what happens to existing data.
- Do not repeat anything already written above, and do not propose a criterion
  you could not check by looking at the running app or its tests.
- Four to eight is usually right. Fewer, if the card is genuinely small.

These go into a list a person is editing, so propose only what you would
defend.
