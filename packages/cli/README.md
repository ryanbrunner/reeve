# reeve

The command line for Reeve: it starts the server, and it drives the board from
a terminal, or from another tool, without opening it.

## Install

From the checkout:

```sh
npm install
npm run build          # the web app `reeve` serves
npm link -w @reeve/cli
```

`reeve` is now on your PATH in any directory. Without linking, `npm run cli --`
runs the same thing, though npm runs it from the checkout's root, so that is the
directory it infers a repo or card from.

The link points at the live checkout rather than a copy. Switching branches or
pulling changes the `reeve` you run at once, and the database stays the
checkout's `data/reeve.db`, the same one `npm run dev` uses — so a branch with a
migration applies it to that database the next time `reeve` starts.

## Commands

```sh
reeve                           # start Reeve and open the board
reeve --no-open --port 4400     # start it without a browser, elsewhere
reeve list [--stage S] [--repo NAME]
reeve add "Title" [--body TEXT | --body-file PATH|-] [--repo NAME] [--stage S]
reeve move <card> <stage> [--index N]
reeve show [<card>]
reeve open [<card>]
reeve card <action> [<card>]    # worktree, pr, resolve-conflicts, server, diff, commits
reeve settings [set|unset ...]
reeve models
reeve repos [add|edit|show ...]
reeve sicko [on|off]
```

- **`reeve`** opens the board in the browser. If Reeve is not already running
  it starts it first, in the foreground; Ctrl-C stops it. It will not start a
  second server over one that is running.
- **`<card>`** is `142`, `#142`, `reeve#142`, or a card id or a prefix of one.
  A bare number means that card in the repo you are in. Outside any repo it
  means that card in whichever repo has one, and it is an error naming them
  when more than one does. Archived cards cannot be named.
- **`<stage>`** is `backlog`, `planning`, `in-progress` (or `in_progress`, or
  `"In Progress"`), `testing` or `done`.
- **`reeve add`** puts the card in the repo you are in unless `--repo` says
  otherwise. `--body-file -` reads the body from stdin.
- **`reeve move`** puts the card at the end of the column unless `--index` says
  otherwise.
- **`reeve show`** with no card shows the card whose worktree you are in. A
  Claude session working on a card can ask what it is working on.

Creating a card in, or moving one to, Planning, In Progress or Testing starts a
Claude run there, exactly as a drag does, and moving one to Done opens its pull
request. The CLI says so on stderr first. Reeve records these as your actions,
whoever ran the command.

### Card actions

The buttons on a card's rail, for a caller who is not looking at it. Each
takes a card, or acts on the one whose worktree you are in when given none.

```sh
reeve card worktree [<card>] [--remove]
reeve card pr [<card>]
reeve card resolve-conflicts [<card>]
reeve card server [<card>] [--stop]
reeve card diff [<card>] [--stat]
reeve card commits [<card>]
```

- **`worktree`** prints the worktree's path and nothing else on stdout, so
  `cd "$(reeve card worktree 12)"` works. A card from Planning on gets one made
  if it has none, and the repo's setup command starts in it. `--remove` stops
  its dev server, runs the repo's teardown command and deletes the directory,
  uncommitted work included. The branch stays, and while it does, making the
  card's worktree again fails: the server cuts a new branch of the same name.
- **`pr`** pushes a Done card's branch and opens its pull request, or pushes to
  the one already open, and prints its URL. Entering Done does this once on
  its own; this is the retry.
- **`resolve-conflicts`** merges the base branch into a Done card's branch. A
  clean merge is pushed at once; a conflicted one starts a Claude run that
  resolves it and pushes when done.
- **`server`** starts the repo's dev server in the card's worktree and prints
  its URL, or the URL of the one already running. `--stop` stops it.
- **`diff`** is what the card changed since its worktree was made, committed or
  not, as a unified diff to read. It is rebuilt from what the Diff tab shows
  and has no index lines, so for a patch to apply, run git in the worktree.
  `--stat` is a line per file.
- **`commits`** lists the card's commits, newest first.

### Settings and repos

```sh
reeve settings
reeve settings set max-concurrent-runs 4
reeve settings set in-progress.model opus
reeve settings set testing.effort high
reeve settings unset in-progress.model
reeve models

reeve repos
reeve repos show <repo>
reeve repos add [<path>] [--name N] [--branch B] [--setup CMD] [--test CMD] ...
reeve repos edit <repo> [--path P] [--test CMD] ...
```

- **`settings`** shows the run cap, SICKO MODE, and each stage's model and
  effort, with the stage's own default where nothing is set. `unset` goes
  back to that default.
- **`models`** lists what the Claude CLI offers for `<stage>.model`. A model
  it does not list is saved anyway, with a warning.
- **`repos add`** registers the repo at a path, or the one you are in. A path
  inside a repo registers the whole repo. It refuses a card's worktree and a
  repo already registered. The name defaults to the repo's directory name,
  the branch to the one it is on, the worktree root to `.reeve-worktrees`
  beside it and the lane colour to one no other repo has. The other flags are
  `--worktree-root`, `--server`, `--teardown`, `--finish`, `--color` and
  `--budget` (dollars per card), the fields of the Settings form.
- **`repos edit`** changes only the flags given. An empty value, as in
  `--setup ''`, clears a command, the colour or the budget.

### SICKO MODE

```sh
reeve sicko           # whether it is on, and what it has done
reeve sicko on
reeve sicko off
```

SICKO MODE takes Reeve's human gates off every card on the board: it approves
reviews unread, answers Claude's questions for it, moves Backlog straight into
In Progress, and opens and merges pull requests, with nobody watching, until it
is switched off. It is not a key under `settings set`, and `reeve sicko on`
does not ask whether you are sure; like the switch on the board, it is its own
undo. It prints, on stderr, each guardrail it just took off and how many
cards on the board each one is about to touch. Tool permissions, the
concurrency cap and branch protection stay as they are.

## For other tools

Every command except `reeve` itself and `open` takes `--json`. stdout is then a
single JSON document — the cards, a card, its detail, diff or commits, the
settings, a repo — and anything said to a person goes to stderr.

Without `--json`, the card actions still put the one thing a script wants on
stdout alone: `worktree` the path, `pr` and `server` the URL.

Exit status is 0 on success, 1 when Reeve refused or could not be reached, and
2 for a mistake in the command itself.

Every command except `reeve` itself talks to a running Reeve over HTTP rather
than to its database, so they need Reeve to be running and say so when it is
not. They look for it at `$REEVE_URL`, else `http://127.0.0.1:$REEVE_PORT`,
else `http://127.0.0.1:4317`.

## Tests

```sh
npm test -w @reeve/cli
```
