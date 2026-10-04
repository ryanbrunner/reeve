# homebrew-reeve

A Homebrew tap for [Reeve](https://github.com/ryanbrunner/reeve), published
to npm as `reeve-board`.

```sh
brew install ryanbrunner/reeve/reeve
```

The formula follows homebrew-core's own Node pattern — `depends_on "node"`,
`std_npm_args`, `bin.install_symlink` — on purpose, so it can move there
unchanged once Reeve has the install base homebrew-core asks for.

## Bumping the formula

`bin/bump-formula.sh [version]` rewrites `Formula/reeve.rb`'s `url` and
`sha256` for a release already on npm; with no argument it uses whatever
`npm view reeve-board version` reports. Run it by hand after `npm publish`,
or let `.github/workflows/bump.yml` pick the release up on its daily
schedule — `workflow_dispatch` with a `version` input runs the same bump on
demand, right after a publish, instead of waiting for the schedule.

## Checking a change

```sh
brew style Formula/reeve.rb
brew audit --strict --new --online ryanbrunner/reeve/reeve   # once tapped
brew install --build-from-source ryanbrunner/reeve/reeve
brew test ryanbrunner/reeve/reeve
```

`--online` needs the `url` it checks to actually resolve, so it only passes
once a version has been bumped to a release that is really on npm.
