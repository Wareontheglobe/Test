#!/usr/bin/env bash
# Run the tests, then publish the app: push this branch and update gh-pages, which GitHub Pages serves.
# Usage: ./publish.sh   (commit your changes first)
set -euo pipefail
cd "$(dirname "$0")"
if [ -n "$(git status --porcelain)" ]; then echo "Commit your changes first."; exit 1; fi
node tests/run.cjs
branch=$(git rev-parse --abbrev-ref HEAD)
git push origin "$branch"
git push origin "$branch:gh-pages"
echo "Published $(git rev-parse --short HEAD). GitHub Pages takes about a minute to update."
