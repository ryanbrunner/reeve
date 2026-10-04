# Releasing

A release is a `v*` tag. Pushing one runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which
typechecks and tests the repo, builds `packages/cli` (`reeve-board`) the same
way `npm pack`/`publish` always does, checks the tag against the package's
own version, publishes to npm, and creates a GitHub Release whose notes carry
the published tarball's sha256 — the one number a Homebrew formula needs
alongside the tarball's URL.

To cut one:

```sh
npm version <patch|minor|major> -w reeve-board
git push --follow-tags
```

`npm version -w reeve-board` bumps `packages/cli/package.json` only — the
root package and the other workspaces stay unversioned — commits that change,
and tags it `v<version>`. `--follow-tags` pushes the commit and the tag
together; the workflow only runs once the tag lands.

The workflow publishes under the `NPM_TOKEN` repository secret, an npm
automation token with publish rights on `reeve-board`; it is never committed.
`GITHUB_TOKEN` is the one GitHub Actions already provides for the Release.

A tag whose version doesn't match `packages/cli/package.json` fails the
workflow before anything publishes, so a release is always the commit
`npm version` made, not whatever HEAD happened to be when someone typed
`git tag`.
