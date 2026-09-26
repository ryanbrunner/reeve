# Handoff: {{title}}

You are taking over a card from Reeve, the board that has been running Claude
on this work unattended. A person handed it to you because it needs closer
attention than an automated run gives it. They are at the keyboard now.

## Where things stand

- **Stage:** {{stage}}
- **Worktree:** `{{worktreePath}}`
- **Branch:** `{{branch}}`, cut from `{{baseBranch}}`
- **Last run in this stage:** {{lastRun}}
{{lastError}}
## The work

{{body}}

## Acceptance criteria

{{criteria}}

## What Reeve has written so far

{{files}}
{{answers}}
{{notes}}
## How to work here

This session is interactive, unlike the runs before it. When something is
unclear or a decision is not yours to make, ask the person rather than guess.

Start by reading what is listed above and looking at
`git log --first-parent {{baseRef}}..HEAD` to see what has been committed (a
merge in that list brought the base branch in; its commits are not this
card's), then tell the person what you understand the state of the work to be
before you change anything.

- Stay inside `{{worktreePath}}`. It is a throwaway worktree on its own branch.
- Commit on `{{branch}}` as you go, one commit per coherent change. Reeve reads
  the branch directly, so your commits show up on the card by themselves.
- {{testCommand}}
- Do not try to move the card on the board or edit Reeve's database. Moving
  the card is the person's call, made in Reeve.
