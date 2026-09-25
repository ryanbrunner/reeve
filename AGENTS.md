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
changes the card's activity, not its column. SICKO MODE
(`packages/server/src/sicko/`) is the deliberate exception: a sweep that
approves, answers and advances cards with nobody watching. It takes off
Reeve's own human gates and nothing else.

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
  SICKO MODE's styles are scoped under `.sicko` in `packages/web/src/sicko.css`.
- `packages/cli` (`@reeve/cli`) — the `reeve` command. It boots the server,
  and everything else it does goes through the running server's HTTP API,
  never the database. `packages/cli/README.md` lists the commands.

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
- `npm run typecheck` — `tsc --noEmit` in every workspace.
- `npm run db:generate` — drizzle-kit; see Database migrations below.

Settings are env vars read in `packages/server/src/config.ts`: `REEVE_DB`,
`REEVE_ASSETS`, `REEVE_PORT`, `REEVE_MAX_CONCURRENT`, `REEVE_MERGE_SYNC_MS`,
`REEVE_AUTO_ARCHIVE_MS`, `REEVE_SICKO_SWEEP_MS`. By default the database is
`data/reeve.db` and mockups and screenshots go in `data/assets/`; `data/` is
gitignored and created at runtime. The server binds to 127.0.0.1 only.

## Checking a change

`npm run typecheck` is the gate. The only tests are the CLI's card and cwd
resolution, `npm test -w @reeve/cli`; the server and web app have none.

Behaviour is checked by the throwaway scripts in `packages/server/src/spikes/`,
each a standalone `tsx` file that builds an app, drives it and prints what it
found. From the repo root:

    REEVE_DB=/tmp/scratch.db npx tsx packages/server/src/spikes/sicko-check.ts

Always give a spike a scratch `REEVE_DB`, never `data/reeve.db`. The spikes
that call `createApp()` open `data/reeve.db` when `REEVE_DB` is unset, and the
SICKO MODE spikes move real cards on whatever board they are given.

For looking at the UI without spending API credit,
`packages/server/src/spikes/seed-card-detail.ts` seeds a card in every
activity state and `packages/server/src/spikes/seed-sicko-board.ts` a board in
SICKO MODE. Either can seed a scratch database, and a server started with the
same `REEVE_DB` then shows it; the header of `seed-sicko-board.ts` has the
command. The header of `seed-card-detail.ts` names `data/reeve.db`, but a
scratch database works the same way, since the script creates the repo it
needs.

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
- **Timers, `gh` calls, the SICKO sweep and model listing stay out of
  `createApp()`.** It checks contracts, migrates, reaps orphaned runs and
  builds routes, and nothing more. The rest starts only in `startServer()`,
  which `packages/server/src/main.ts` and `reeve` call, because the spikes
  build an app and must not start any of it.
- **Loopback only, no auth.** The server runs arbitrary code in your repos;
  `hostname` in `packages/server/src/config.ts` stays `127.0.0.1`.
- **Tool permissions deny by default.** A stage's `allowedTools` is the
  policy; `packages/server/src/runs/permissions.ts` answers everything else,
  and its one allowance is rewriting `git -C <the worktree> …` to plain `git …`,
  never a widening. SICKO MODE does not widen permissions either.

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
worktree is made (`packages/server/src/startStage.ts`). Never symlink the main
checkout's `node_modules` into a worktree: removing the worktree deletes the
real one through the link.

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
