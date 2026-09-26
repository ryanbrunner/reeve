You are finishing a merge in the repository at `{{worktreePath}}`.

The branch `{{branch}}` has an open pull request that GitHub cannot merge,
because `{{base}}` has moved on underneath it. `origin/{{base}}` has already
been merged into the branch, and the merge stopped on conflicts. Your job is
to resolve them and commit the merge.

## The work on this branch

**{{title}}**

{{body}}

### The approved plan

{{plan}}

### What was built

{{implementation}}

## Conflicted files

{{conflicts}}

## What to do

For each file, understand what both sides were trying to do before you touch
it. `git show :1:<path>` is the common ancestor, `:2:<path>` is this branch and
`:3:<path>` is `{{base}}`. `git log HEAD..origin/{{base}}` shows what landed on
the base branch since this branch started, and `git diff` helps too.

- Keep the intent of both sides. The base branch's changes are already
  reviewed and landed, so do not drop them to make this branch's work fit;
  adapt this branch's work to them instead.
- Where both sides changed the same thing in incompatible ways, prefer the
  base branch's shape and re-apply this branch's purpose on top of it.
- Remove every conflict marker. Look beyond the marked hunks, too: code that
  merged cleanly can still be broken by the other side, such as a call to a
  function the base branch renamed.
- `git add` each file once it is resolved.

### Migrations

Two branches that each add a drizzle migration both take the next free number,
so they collide in `meta/_journal.json`, in the snapshots and in the `.sql`
file names, even when the schema changes have nothing to do with each other.
The base branch's migrations have already run wherever it is deployed, so they
stay exactly as they are and this branch's migration moves after them.

- Take the base's `meta/_journal.json` and every snapshot it added unchanged.
  Read them with `git show :3:<path>` and write them back with the Write tool.
- For a schema migration, `git rm` this branch's `.sql` file (and its snapshot,
  if the base did not take that path), merge the schema source itself, then
  run the `db:generate` script from the repository root, naming the package
  that owns the drizzle config: `npm run db:generate --workspace <package>`.
  It writes a fresh migration numbered after the base's, from the merged
  schema. If it stops to ask whether a column was renamed, nobody is here to
  answer: do not commit, and say so in `concerns`.
- `db:generate` writes nothing for a data-only migration, so renumber that one
  by hand: `git mv` the `.sql` file to the next free number, add a journal
  entry with the next `idx` and that tag, and add a snapshot for it that copies
  the base's last snapshot with a new `id` and a `prevId` of the base's last `id`.
- Check the chain before you commit: each snapshot's `prevId` is the `id` of
  the one before it, and the journal lists every `.sql` file once, in order.

{{testCommand}}

When every file is resolved and staged, conclude the merge with
`git commit --no-edit`. Make that one commit and no other.

Do not run `git merge`, `git rebase`, `git reset`, `git checkout`, `git stash`
or `git push`. The merge is already under way, and the server checks your
commit and pushes it to the pull request once you are done. If you cannot
resolve a file with confidence, do not commit: say why in `concerns`, and the
merge will be put back as it was.

## What to report

- `summary`: what the two sides were doing and how you reconciled them.
- `files`: every conflicted file, with what you kept from each side and why.
- `concerns`: anything a reviewer should look at twice. The merge reaches the
  pull request without a person reading it first, so say plainly where you
  guessed.
