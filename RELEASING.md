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
git add packages/cli/package.json package-lock.json
git commit -m "Release v<version>"
git tag v<version>
git push && git push origin v<version>
```

`npm version -w reeve-board` bumps `packages/cli/package.json` (and the
lockfile) only — the root package and the other workspaces stay unversioned.
Run with `-w`, it never commits or tags on its own the way a bare `npm
version` does, so both are a separate, explicit step here; the tag is what
the workflow waits for, so it has to be pushed, not just created.

The workflow publishes under the `NPM_TOKEN` repository secret, an npm
automation token with publish rights on `reeve-board`; it is never committed.
`GITHUB_TOKEN` is the one GitHub Actions already provides for the Release.

A tag whose version doesn't match `packages/cli/package.json` fails the
workflow before anything publishes, so check that the version bump landed
before pushing the tag.
