# reeve

The command line for Reeve: it puts work on the board and shapes it from a
terminal, or from another tool, without opening the board.

## Install

From the checkout:

```sh
npm install
npm link -w @reeve/cli
```

`reeve` is now on your PATH in any directory. Without linking, `npm run cli --`
runs the same thing, though npm runs it from the checkout's root, so that is the
directory it infers a repo or card from.

Reeve itself has to be running (`npm run dev`, or `npm start`). The CLI talks to
it over HTTP and never opens the database: creating or moving a card starts runs
the server holds in memory. It looks for Reeve at `$REEVE_URL`, else
`http://127.0.0.1:$REEVE_PORT`, else `http://127.0.0.1:4317`.

## Commands

```sh
reeve project add "Title" [--body TEXT | --body-file PATH|-] [--repo R] [--split]
reeve card add "Title" [--body TEXT | --body-file PATH|-] [--repo R] [--project P] [--stage S] [--ref PATH|URL]...
reeve card edit <card> [--title T] [--body …] [--repo R | --no-repo] [--model M] [--effort E] [--ref PATH|URL]...
reeve card criteria list|add|rm <card> …
reeve card note <card> <text>
reeve card move <card> <stage> [--index N] [--project P | --no-project]
reeve card archive <card>
reeve card restore <card>
```

`reeve card move --help`, and the same for every command, says what it does in
full.

- **`<card>`** is `142`, `#142`, `reeve#142`, or a card id or a prefix of one.
  A bare number means that card in the repo you are in; outside any repo it
  means whichever repo has one, and it is an error naming them when more than
  one does. The card commands take a project too, by its id or its title.
- **`<stage>`** is `backlog`, `planning`, `in-progress` (or `in_progress`, or
  `"In Progress"`), `testing` or `done`.
- **`--repo`** takes a repo's name or its id. Without it a new card goes in the
  repo you are in, else its project's repo, else the only repo there is.

**A move is a human action.** Moving a card into Planning, In Progress or
Testing starts a Claude run there, exactly as a drag does, and moving it into
Done pushes its branch and opens a pull request. So does `card add --stage` into
a Claude column, and `project add --split`. The command waits a few seconds and
says on stderr what it set off: the run's id, the pull request's link, or why
nothing started. Reeve records these as your actions, whoever ran the command.

Criteria are numbered from 1, as `criteria list` shows them. There is no
`criteria check`: a verdict is Testing's, and belongs to the run that reached it.

## For other tools

```sh
id=$(reeve card add "Gift notes" --repo shop --quiet)
reeve card criteria add "$id" "A note prints on the packing slip"
reeve card move "$id" planning
```

`card add` and `project add` print the new id on its own with `--quiet`. Every
command takes `--json`, and stdout is then a single JSON document — the card,
the criterion, the note — while anything said to a person goes to stderr.

Exit status is 0 on success, 1 when Reeve refused or could not be reached, and
2 for a mistake in the command itself. Reeve's refusals — a project cannot be
moved, projects do not nest — are passed on as the server words them.

## Checking it

There is no test suite. The spike drives every command against a scratch
database, without spending API credit:

```sh
REEVE_DB=/tmp/reeve-cli.db npx tsx packages/server/src/spikes/cli-check.ts
```
