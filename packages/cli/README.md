# reeve

The command line for Reeve. So far it reads: what is on the board, a card in
full, the repos, and a card's runs. It is written for other agents first and
people second, so every command has a `--json` mode.

## Install

From the checkout:

```sh
npm install
npm link -w @reeve/cli
```

`reeve` is then on your PATH in any directory. Without linking,
`npm run cli -- <command>` runs the same thing from the checkout's root.

## Commands

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
- **`<card>`** is a card's id or any prefix of it that no other card shares,
  archived cards and projects included. The board shows the first eight
  characters, which are also what the card's branch and worktree are named
  after.
- **`<stage>`** is `backlog`, `planning`, `in-progress` (or `in_progress`, or
  `"In Progress"`), `testing` or `done`.
- **`--project`** takes a project's title, ignoring case, or its id or a
  prefix of one.

## For other tools

With `--json`, stdout is a single JSON document and nothing else: the API's
answer as the web app gets it, typed by `@reeve/shared`.

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
2 for a mistake in the command itself; the message is on stderr.

The CLI talks to a running Reeve over HTTP, never to its database, so Reeve
has to be running. It looks for it at `$REEVE_URL`, else
`http://127.0.0.1:$REEVE_PORT`, else `http://127.0.0.1:4317`.
