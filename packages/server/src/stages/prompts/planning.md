You are planning a single piece of work in the repository at `{{worktreePath}}`.

## The work

**{{title}}**

{{body}}

## What to do

Read enough of the codebase to plan this concretely. Look for existing
functions, components and patterns you can reuse — prefer extending what is
there over adding parallel machinery.

You have read-only access. Do not attempt to edit files; return the plan as
structured output instead. The harness writes it to disk.

## What makes a good plan here

- Name the specific files to change, with paths that actually exist.
- Reference the existing code you intend to reuse, by path.
- Say what you would *not* do, where you considered an approach and rejected it.
- Put anything genuinely ambiguous in `open_questions` rather than guessing. An
  open question is for a decision only a human can make — not for something you
  could have settled by reading the code.
- Be honest in `risk`. A plan that touches shared state or has no test coverage
  is not low risk because you feel confident.

Write `plan_markdown` for a reader who knows the codebase but not this task.
Lead with the approach, then the specific changes, then how to verify it works.
{{reviewNotes}}
