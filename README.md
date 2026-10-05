# Reeve

A local kanban board for work in your own git repos, where Claude does the
work. Each card is one piece of work in one repo, and gets its own git
worktree and branch. The board has five columns:

    backlog → planning → in_progress → testing → done

Planning, In Progress and Testing each run Claude, through the Claude Agent
SDK, in the card's worktree. Planning writes a plan, In Progress builds it,
and Testing checks the result against the card's acceptance criteria. Backlog
and Done are holding areas: nothing runs there. Moving a card into Done pushes
its branch and opens a pull request.

**Claude never moves a card; you do**, by dragging it to another column or by
approving the stage it has finished, which moves it one column on. A run that
finishes on its own leaves the card where it is, waiting for your review, or
for your answers when Claude has asked questions. You can send a stage back
with notes instead, and they become its next prompt.

VIBES MODE (`reeve vibes on`) is the one exception, and it is off until you
switch it on: it approves, answers and advances cards with nobody watching.

## Requirements

- Node 22.12 or newer
- git
- a Claude login, the one Claude Code uses, or `ANTHROPIC_API_KEY` in the
  environment

Optionally:

- [`gh`](https://cli.github.com), logged in, to push a Done card's branch and
  to open and merge its pull request
- Playwright's Chromium, for mockups and screenshots:
  `npx playwright install chromium`

## Install

Homebrew is coming once the tap exists. Until then, install from source:

```sh
git clone https://github.com/ryanbrunner/reeve.git
cd reeve
npm install
npm run build -w reeve-board
npm link -w reeve-board
```

`npm run build -w reeve-board` builds the web app and bundles the CLI, server
and shared code into `dist/`, which `reeve serve` needs and will not start
without. `npm link` puts `reeve` on your PATH.

## Running it

```sh
reeve serve
```

This starts Reeve and opens the board at http://127.0.0.1:4317. If Reeve is
already running it only opens the board. `--port`, `--db`, `--assets` and
`--max-concurrent` change where it listens, where it keeps its database and
images, and how many runs go at once; `--no-open` leaves the browser alone.
By default the database, mockups and screenshots go in `data/` in the
checkout.

Then give it a repo, from Settings on the board or from a terminal, and a card
to work on:

```sh
reeve repos add ~/code/shop
reeve card add "Gift notes" --repo shop
```

The card lands in Backlog. Drag it to Planning, or run
`reeve card move <card> planning`, and Claude starts.

Everything on the board can be done from the `reeve` command too, including
following a run, answering Claude's questions and approving a stage. It is
written to be driven by scripts and other agents as well as by people: see
[its README](packages/cli/README.md), or `reeve --help`.

## Security

Reeve's server listens on 127.0.0.1 only, and has no authentication, because
it runs commands and edits files in your repos. Anyone who can reach it can do
the same. Do not expose it to a network or put a proxy in front of it.

Within a run, a stage may use only the tools it is allowed; everything else is
denied.

## Development

```sh
npm run dev         # the server on 4317 and Vite on 5173, both reloading
npm run typecheck   # the check every change has to pass
```

[AGENTS.md](AGENTS.md) describes how the code is laid out, the rules it
depends on, and how to check a change. [RELEASING.md](RELEASING.md) describes
how a version is cut and published.

## License

MIT; see [LICENSE](LICENSE).
