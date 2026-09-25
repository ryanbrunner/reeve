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

## For other tools

`list`, `add`, `move` and `show` take `--json`. stdout is then a single JSON
document — the cards, the new or moved card, or the whole card detail — and
anything said to a person goes to stderr.

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
