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

The board, its database and its images, lives in the checkout's gitignored
`data/` when Reeve runs from a git checkout, and in `~/.reeve` when it runs
from an installed copy (the same on macOS and Linux; `XDG_DATA_HOME` plays no
part). Either is created on first run, and the server prints the database's
path when it starts. `REEVE_DB` and `REEVE_ASSETS`, or `reeve serve --db` and
`--assets`, put it anywhere else.

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
reeve card archive <card> [--detach-open]
reeve card restore <card>
reeve repos add [PATH] / reeve repos edit <repo> [--setup CMD] [--test CMD] [--seed CMD] [--server CMD] …
reeve repos show <repo> [--json]
reeve card accept <card>
reeve card dismiss <card>
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

**Archiving a project takes its Done cards with it.** A project with cards not
yet Done is refused, and the refusal names them; `--detach-open` archives it
anyway and moves them to No project. Restoring the project brings back the Done
cards that went with it, and leaves the moved ones where they are.

`repos add` and `repos edit` take the Settings form's fields as flags, and a
blank one clears it. `--seed` is the command Testing runs before its
screenshots, after stopping the card's dev server and before starting it again,
so the pictures show fixture data rather than an empty page. `repos show`
prints it as the Seed row.

**`card accept` and `card dismiss` are for cards a run suggested**, the Accept
and Reject buttons on a suggestion's face; `card approve` and `card reject` are
the review gate, and have nothing to do with them. Accepting leaves the card in
Backlog and takes away its badge. Dismissing archives it, which also stops the
same title being suggested again, and `card restore` brings it back. Anything
else — a card a person made, one already decided, one out of Backlog — is
refused, and the refusal says which. A script finds the ones waiting in
`board --json`, as the `cards` with `pendingSuggestion` true.

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

| Command            | Endpoint                         | Type                  |
| ------------------ | -------------------------------- | --------------------- |
| `board`            | `GET /api/board`                 | `BoardResponse`       |
| `board --archived` | `GET /api/cards/archived`        | `ApiCard[]`           |
| `card show`        | `GET /api/cards/:id/detail`      | `CardDetail`          |
| `repos`            | `GET /api/repos`                 | `ApiRepo[]`           |
| `runs`             | `GET /api/cards/:id/runs`        | `ApiRunSummary[]`     |
| `card archive`     | `POST /api/cards/:id/archive`    | `ArchiveCardResponse` |
| `card restore`     | `POST /api/cards/:id/restore`    | `ApiCard`             |
| `card accept`      | `POST /api/cards/:id/suggestion` | `ApiCard`             |
| `card dismiss`     | `POST /api/cards/:id/suggestion` | `ApiCard`             |

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
