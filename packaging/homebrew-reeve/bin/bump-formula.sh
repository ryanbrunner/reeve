#!/usr/bin/env bash
# Rewrites Formula/reeve.rb's `url` and `sha256` for a new release of
# `reeve-board` on npm. Run by hand after `npm publish`, or by
# .github/workflows/bump.yml on a schedule.
#
# Usage: bin/bump-formula.sh [version]
# With no version, uses whatever npm currently has as `latest`.
set -euo pipefail

cd "$(dirname "$0")/.."

version="${1:-$(npm view reeve-board version)}"
tarball_url="https://registry.npmjs.org/reeve-board/-/reeve-board-${version}.tgz"

tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT
curl -fsSL "$tarball_url" -o "$tmpfile"
sha256="$(shasum -a 256 "$tmpfile" | cut -d' ' -f1)"

formula="Formula/reeve.rb"
sed -i.bak -E \
  -e "s#url \"https://registry.npmjs.org/reeve-board/-/reeve-board-[^\"]+\.tgz\"#url \"${tarball_url}\"#" \
  -e "s#sha256 \"[0-9a-f]+\"#sha256 \"${sha256}\"#" \
  "$formula"
rm -f "${formula}.bak"

echo "Bumped $formula to reeve-board ${version} (sha256 ${sha256})"
