# reeve

The command line for Reeve: it reads the board, drives the runs on it, and
puts work on it, from a terminal or from another tool without opening the
board. It is written for other agents first and people second, so every
command has a `--json` mode.

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

## Reading

```sh
reeve board [--repo NAME] [--project TITLE|ID] [--stage S] [--archived] [--json]
reeve card show <card> [--json]
reeve repos [--json]
reeve runs <card> [--json]
```

- **`reeve board`** prints the board column by column, one card to a line:
  its short id, activity (and pull request, on Done), repo, project and title.
  The projects follow as their own list. `--archived` lists what has been taken
  off the board instead, most recently archived first.

## Driving a run

```sh
reeve card run <card> [--follow] [--json]
reeve card approve <card> [--notes TEXT] / reeve card reject <card> --notes TEXT
reeve card questions <card> [--json] / reeve card answer <card> <question> <answer>
reeve card wait <card> [--timeout S] [--json]
reeve run follow <run> [--json] / reeve run stop <run>
```

Approving does not move the card. Claude never moves a card; a human does, and
from here that is `card move`.

`card wait` blocks until the card's run wants a person and says which by its
exit status: 0 it finished and awaits review, 3 Claude asked questions, 4 the
run failed, 5 nothing was running, 6 `--timeout` ran out.

## Writing

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

`reeve card move --help`, and the same for every command that writes, says what
it does in full.

**A move is a human action.** Moving a card into Planning, In Progress or
Testing starts a Claude run there, exactly as a drag does, and moving it into
Done pushes its branch and opens a pull request. So does `card add --stage` into
a Claude column, and `project add --split`. The command waits a few seconds and
says on stderr what it set off: the run's id, the pull request's link, or why
nothing started. Reeve records these as your actions, whoever ran the command.

`card merge` is the board's Merge button: it lands a Done card's pull request
on GitHub, and only once GitHub has said it merges cleanly. Branch protection
still applies, and a refusal says what `gh` said.

Criteria are numbered from 1, as `criteria list` shows them. There is no
`criteria check`: a verdict is Testing's, and belongs to the run that reached it.

## What the arguments take

- **`<card>`** is `142`, `#142`, `reeve#142`, or a card id or a prefix of one.
  A bare number means that card in the repo you are in; outside any repo it
  means whichever repo has one, and it is an error naming them when more than
  one does. The card commands take a project too, by its id or its title.
- **`<stage>`** is `backlog`, `planning`, `in-progress` (or `in_progress`, or
  `"In Progress"`), `testing` or `done`.
- **`--repo`** takes a repo's name or its id. Without it a new card goes in the
  repo you are in, else its project's repo, else the only repo there is.
- **`--project`** takes a project's title, ignoring case, or its id or a
  prefix of one.

## For other tools

```sh
id=$(reeve card add "Gift notes" --repo shop --quiet)
reeve card criteria add "$id" "A note prints on the packing slip"
reeve card move "$id" planning
```

`card add` and `project add` print the new id on its own with `--quiet`. With
`--json`, stdout is a single JSON document and nothing else — the API's answer
as the web app gets it, typed by `@reeve/shared` — while anything said to a
person goes to stderr.

| Command            | Endpoint                    | Type              |
| ------------------ | --------------------------- | ----------------- |
| `board`            | `GET /api/board`            | `BoardResponse`   |
| `board --archived` | `GET /api/cards/archived`   | `ApiCard[]`       |
| `card show`        | `GET /api/cards/:id/detail` | `CardDetail`      |
| `repos`            | `GET /api/repos`            | `ApiRepo[]`       |
| `runs`             | `GET /api/cards/:id/runs`   | `ApiRunSummary[]` |

`board`'s filters narrow the arrays in that document and leave its shape
alone: `cards` loses what does not match, and `projects` loses projects outside
`--repo` or `--project`.

Exit status is 0 on success, 1 when Reeve refused or could not be reached, and
2 for a mistake in the command itself; the message is on stderr. Reeve's
refusals — a project cannot be moved, projects do not nest — are passed on as
the server words them. `card wait` has statuses of its own, above.

## Checking it

There is no test suite. The spikes drive the commands against a scratch
database, without spending API credit:

```sh
REEVE_DB=/tmp/reeve-cli.db npx tsx packages/server/src/spikes/cli-check.ts
```
