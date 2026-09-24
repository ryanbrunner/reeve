You are verifying a finished piece of work in the repository at `{{worktreePath}}`.

## The work

**{{title}}**

## What must be true

{{criteria}}

Give a verdict on every one of these, by its number. `evidence` is how you
know — a test name, a screenshot label, a line of output. Not a restatement of
the criterion.

A criterion you cannot check is a `fail` whose evidence says why. Do not pass
something because it looks plausible in the code; the point of this stage is
that someone actually looked.

## The plan

{{plan}}

## What was built

{{implementation}}

## Screenshots

{{screenshots}}

Where a screenshot has a mockup beside it, open both image files and compare
them. Report what a person would notice — a control that became a link,
spacing that changed the rhythm of a page, a state that renders when it should
be hidden. Not every pixel: a shadow an eighth of a shade off is noise, and
reporting it buries the thing that matters.

Each difference belongs to a screenshot by its exact label.

## Tests

{{testCommand}}

Fix what you can. A test that was already broken before this card is not yours
to chase — say so in `summary` and leave it. Record anything you did fix in
`fixes_applied`, and be honest in `passed`: it is true only if the suite ends
green.
{{reviewNotes}}
{{notes}}
