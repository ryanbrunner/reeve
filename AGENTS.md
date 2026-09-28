# Reeve

A local kanban board where each card is a piece of work in one of your repos,
and each column past Backlog runs a Claude Agent SDK stage in that card's own
git worktree:

    backlog → planning → in_progress → testing → done

Planning, In Progress and Testing run Claude; Backlog and Done are holding
areas (`packages/shared/src/stages.ts`). A card's column is its stage — there
is no second status field.

The rule the whole board is built around: **Claude never moves a card; a human
action does**, whether a drag or an approval. A run finishing on its own
changes the card's activity, not its column. VIBES MODE
(`packages/server/src/vibes/`) is the deliberate exception: a sweep that
approves, answers and advances cards with nobody watching, and, with the
board's switch on, asks Claude for the next cards once a repo has run out of
work (`vibes/ideas.ts`). It takes off Reeve's own human gates and nothing
else.

This file describes the project. What a stage run should do is in its prompt,
under `packages/server/src/stages/prompts/`, and that wins.

## Layout

npm workspaces, four packages:

- `packages/shared` (`@reeve/shared`) — the zod contracts Claude answers in,
  and the API types both sides share. Imported as TypeScript source; there is
  no build step.
- `packages/server` (`@reeve/server`) — Hono, better-sqlite3 with drizzle, the
  Agent SDK, and Playwright for screenshots.
- `packages/web` (`@reeve/web`) — Vite, React 19, TanStack Query, Tailwind v4.
  Design tokens are in the `@theme` block of `packages/web/src/index.css`;
  VIBES MODE's styles are scoped under `.vibes` in `packages/web/src/vibes.css`.
- `packages/cli` (`@reeve/cli`) — the `reeve` command. `serve` is the only
  command that imports the server; everything else goes through a running
  server's HTTP API and never its database, because runs live in the server's
  memory and a second process opening the database reaps them. Its `--json`
  output is the API's own wire types from `@reeve/shared`, unreshaped; see its
  README. Its `bin/reeve.js` registers tsx and imports `src/main.ts`.

## Commands

Node >= 22.12 (`.tool-versions` pins 22.17.0). From the repo root:

- `npm run dev` — the server on 4317 (`tsx watch`) and Vite on 5173.
  `dev:server` and `dev:web` start one each. Vite proxies `/api` to the server
  and must not buffer SSE, or a run's transcript arrives in one lump at the end
  (`packages/web/vite.config.ts`).
- `npm run build` — builds the web app into `packages/web/dist` (gitignored).
  When that exists, `npm start` serves it from the server on the same port.
- `npm run seed` — one repo and four cards, into an empty database only. Its
  repo paths are hard-coded to one machine.
- `npm run cli -- board` — the `reeve` CLI without linking it, against the
  server on `REEVE_URL` or `REEVE_PORT`.
- `npm run typecheck` — `tsc --noEmit` in every workspace.
- `npm test` — the CLI's resolution tests, and nothing else; see below.
- `npm run cli -- <args>` — the `reeve` command, run from the repo root.
- `npm run db:generate` — drizzle-kit; see Database migrations below.
- `npm run -s cli -- <args>` — the CLI, against a server that is already
  running; see its README. `npm link -w @reeve/cli` puts `reeve` on your PATH
  instead.
- `reeve serve` — the same server as `npm start`, opening the board once it is
  up, and doing nothing but opening it when one is already running. `--port`,
  `--db`, `--assets` and `--max-concurrent` set `REEVE_PORT`, `REEVE_DB`,
  `REEVE_ASSETS` and `REEVE_MAX_CONCURRENT`; relative paths are taken from
  where the command is run.
- `reeve status` — exits 0 if a server answers and 1 if not, so a script can
  ask before starting one.

Settings are env vars read in `packages/server/src/config.ts`: `REEVE_DB`,
`REEVE_ASSETS`, `REEVE_PORT`, `REEVE_MAX_CONCURRENT`, `REEVE_MERGE_SYNC_MS`,
`REEVE_AUTO_ARCHIVE_MS`, `REEVE_VIBES_SWEEP_MS`. Where the board lives
depends on whether the package root has a `.git` (a card's worktree counts).
In a checkout the database is `data/reeve.db` and mockups and screenshots go
in `data/assets/`; `data/` is gitignored. An installed copy, which has no
`.git`, uses `~/.reeve/reeve.db` and `~/.reeve/assets/` instead, on every
platform, so a Homebrew upgrade into a new Cellar directory keeps the board.
Either directory is created on first run. `REEVE_DB` and `REEVE_ASSETS`, or
`reeve serve --db` and `--assets`, win over both. The server binds to
127.0.0.1 only. The migrations and the built web app are part of the install
and always resolve from the package's own location, as does `data/` in a
checkout, never from the working directory, so the server behaves the same
wherever it is started.

The CLI's commands other than `serve` find the server at `--url`, then
`REEVE_URL`, then `http://127.0.0.1:4317`. A server started on another port
needs one of the first two.

## Checking a change

`npm run typecheck` is the gate. The only tests are the CLI's card and cwd
resolution, `npm test -w @reeve/cli`; the server and web app have none.

Behaviour is checked by the throwaway scripts in `packages/server/src/spikes/`,
each a standalone `tsx` file that builds an app, drives it and prints what it
found. From the repo root:

    REEVE_DB=/tmp/scratch.db npx tsx packages/server/src/spikes/vibes-check.ts

Always give a spike a scratch `REEVE_DB`, never `data/reeve.db`. The spikes
that call `createApp()` open `data/reeve.db` when `REEVE_DB` is unset, and the
VIBES MODE spikes move real cards on whatever board they are given.

For looking at the UI without spending API credit,
`packages/server/src/spikes/seed-card-detail.ts` seeds a card in every
activity state and `packages/server/src/spikes/seed-vibes-board.ts` a board in
VIBES MODE. Either can seed a scratch database, and a server started with the
same `REEVE_DB` then shows it; the header of `seed-vibes-board.ts` has the
command. The header of `seed-card-detail.ts` names `data/reeve.db`, but a
scratch database works the same way, since the script creates the repo it
needs. The same seeded board is how to check `reeve card wait`: its cards give
every outcome but a timeout without a single run.

## The CLI

`reeve --help` lists every command. What they are for is driving a card through
the board from a script or an agent:

    reeve card run <card>                  start the card's stage; prints the run id
    reeve run follow <run>                 its transcript, until it ends
    reeve card wait <card>                 block until the card needs a person
    reeve card questions <card>            what Claude asked
    reeve card answer <card> <n> <answer…> the last answer resumes the run
    reeve card approve <card> [--notes]    pass the gate: the card moves one column
    reeve card reject <card> --notes …     send it back; the notes are the next prompt
    reeve run stop <run>

A card is its id, the start of its id (a worktree's directory name), `142`,
`#142` or `<repo>#142`. `--json` puts JSON alone on stdout, and `run follow
--json` one event per line. It finds the server at `REEVE_URL`, else
`http://127.0.0.1:$REEVE_PORT`.

**The exit codes are the contract** (`packages/cli/src/exit.ts`), and are never
renumbered. `wait` exits with the first that applies; `run follow` uses the
same numbers for how its run ended.

| Code | `card wait`                                                                       | `run follow`      |
| ---- | --------------------------------------------------------------------------------- | ----------------- |
| 0    | the run finished and awaits review                                                | the run succeeded |
| 1    | error: Reeve unreachable, no such card, the server refused                        | the same          |
| 2    | the command line was wrong                                                        | the same          |
| 3    | Claude asked questions                                                            | —                 |
| 4    | the stage's run failed or was interrupted                                         | the run did       |
| 5    | idle: nothing running or waiting — Backlog, Done, stopped, or a start was refused | the run was stopped |
| 6    | `--timeout` ran out with the card still running                                   | —                 |

`wait` on a card that already needs a person returns at once. A card that has
just been approved into a runnable column reads idle while its worktree is
made; `wait` keeps waiting through that, because the card says so
(`startingStage`), rather than returning 5. The same holds while a revision or
a resume waits on the worktree's setup, when the card still reads as the
review or the questions it was just given.

Approving is a human gate, and the CLI passes it only when a person or their
script calls `reeve card approve`. Nothing in the CLI approves, answers or
advances a card on its own; that is VIBES MODE's job, and only when it is
switched on.

## Rules the code depends on

- **Claude returns data; the server writes the documents.** Each stage's
  output is a zod schema in `packages/shared/src/contracts.ts`, and the server
  composes `.reeve/plan.md`, `.reeve/implementation.md` and
  `.reeve/test-report.md` from it. That inversion is what lets Planning run
  with no write tools at all.
- **`.reeve/` is untracked stage output and must never be committed.** It is
  not in `.gitignore` — it is written into whatever repo a card belongs to —
  so `git add -A` or `git add .` would sweep it in. The pull request and
  conflict code skip it when checking whether a worktree is dirty.
- **Contracts stay in the zod subset that converts to JSON Schema**: string,
  number, boolean, enum, array, object. No `z.date()`, `z.bigint()` or
  `.transform()`. `assertContractsConvertible()` converts every one at boot,
  so a bad schema fails startup rather than a run.
- **Stages are code, not rows.** Each is a module registered in
  `packages/server/src/stages/index.ts`, shaped by
  `packages/server/src/stages/types.ts`.
- **Prompts are files.** `packages/server/src/stages/prompts/*.md`, filled by
  `renderPrompt` in `packages/server/src/stages/template.ts`, which replaces
  `{{name}}` and leaves an empty string for any variable not passed.
- **Timers, `gh` calls, the VIBES sweep and model listing stay out of
  `createApp()`.** It checks contracts, migrates, reaps orphaned runs and
  builds routes, and nothing more. The rest starts only in `startServer()`,
  which `packages/server/src/main.ts` and `reeve serve` call, because the
  spikes build an app and must not start any of it.
- **Loopback only, no auth.** The server runs arbitrary code in your repos;
  `hostname` in `packages/server/src/config.ts` stays `127.0.0.1`.
- **Tool permissions deny by default.** A stage's `allowedTools` is the
  policy; `packages/server/src/runs/permissions.ts` answers everything else.
  It allows two things, and neither is a widening: rewriting
  `git -C <the worktree> …` to plain `git …`, and one leading `REEVE_DB=…` on
  an otherwise allowed command, so a stage can run a spike the way this file
  says to. It refuses a `REEVE_DB` that names the running server's own
  database, and any other variable. VIBES MODE does not widen permissions
  either.

## Database migrations

Migrations live in `packages/server/drizzle/` and run on every boot.

- For a schema change: edit `packages/server/src/db/schema.ts`, run
  `npm run db:generate`, then rename drizzle's random tag (`0001_spooky_naoko`)
  to one that says what the migration does, in both the `.sql` filename and
  `packages/server/drizzle/meta/_journal.json`. The oldest few still carry
  drizzle's names.
- `db:generate` emits nothing for a data-only migration. Write the `.sql` by
  hand, separating statements with `--> statement-breakpoint` (see
  `packages/server/drizzle/0009_fold_ready_into_backlog.sql`). Add its journal
  entry, and copy the previous snapshot in `packages/server/drizzle/meta/`
  with a fresh `id` and `prevId` set to the previous snapshot's `id`.
- A journal entry whose `when` is not greater than the last applied
  migration's is **skipped silently**. The database carries on without it and
  nothing reports an error.
- Parallel cards each generate the same next number from the same base, so a
  merge usually means renumbering the later migration and giving it a `when`
  above everything already merged.

## Worktrees

A card's worktree is a fresh checkout. It has no `node_modules` unless the
repo's setup command installed them, which starts in the background when the
worktree is made (`packages/server/src/startStage.ts`). A stage waits for it
before Claude starts, and a reused worktree whose setup never succeeded runs it
again on its next start. Never symlink the main
checkout's `node_modules` into a worktree: removing the worktree deletes the
real one through the link.

As in Claude Code, gitignored files that match the repo's `.worktreeinclude`
(`.gitignore` syntax) are copied from the main checkout when a worktree is
made, before the setup command starts (`copyWorktreeIncludes` in
`packages/server/src/git/worktree.ts`). They are copied, never linked, and
never over a file the worktree already has. A reused worktree gets nothing.

A repo has six lifecycle commands: setup, test, seed, server, teardown and
finish. The seed is for Testing's screenshots, which a fresh worktree's server
would otherwise take of an empty page. When a card has captures to take,
Testing stops the card's dev server, runs the seed in the worktree, and then
starts the server again (`seedForCapture` in
`packages/server/src/stages/testing.ts`). A seed that fails is reported in the
prompt, and the pictures are taken anyway. Resetting old data is the command's
job. The planning prompt names the seed, so a plan whose capture needs a state
the seed lacks extends the seed script. Repo commands never inherit the host's
`REEVE_DB` or `REEVE_ASSETS`, so a worktree's own Reeve opens its own
`data/reeve.db`. For Reeve's own repo the seed is:

    rm -f data/reeve.db data/reeve.db-wal data/reeve.db-shm && REEVE_DB=data/reeve.db npx tsx packages/server/src/spikes/seed-card-detail.ts

It runs from the worktree root, so it writes the database the dev server then
opens. Its merged card is archived on the server's first merge-sync tick
unless `REEVE_AUTO_ARCHIVE_MS` is large; see the script's header.

## Conventions

- Strict TypeScript with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`
  (`tsconfig.base.json`): type-only imports use `import type`, and indexed
  access is `T | undefined`.
- Relative imports carry a `.js` extension, which NodeNext requires in the
  server and shared packages. The web package follows it too, although its
  bundler resolution would not insist.
- Comments explain why, not what, and there are a lot of them. Match the
  density of the file you are in; a card or incident that shaped the code is
  worth naming.
- Commit subjects are plain-English sentences in the imperative ("Tell
  Testing to commit what it fixed"), with no `feat:`-style prefix. The body
  says why, in prose.
