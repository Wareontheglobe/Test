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
sha=$(git rev-parse HEAD); short=$(git rev-parse --short HEAD)
echo "Pushed $short. Waiting for GitHub Pages to put it live..."
command -v gh >/dev/null 2>&1 || { echo "(gh not installed, so the deploy wasn't checked. It takes about a minute.)"; exit 0; }
repo=$(git remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?$#\1#')
# GitHub's own deploy step sometimes fails with a server error. Wait for it, retry it once, and say plainly how it ended.
retried=0
for _ in $(seq 1 45); do
  read -r id status conclusion <<<"$(gh api "repos/$repo/actions/runs?head_sha=$sha&per_page=10" \
    --jq '[.workflow_runs[] | select(.name == "pages build and deployment")][0] | "\(.id) \(.status) \(.conclusion)"' 2>/dev/null || echo "- - -")"
  if [ "$status" = "completed" ]; then
    if [ "$conclusion" = "success" ]; then echo "Live: GitHub Pages is serving $short."; exit 0; fi
    if [ "$retried" = 0 ]; then
      echo "GitHub's deploy step failed ($conclusion). Trying it once more..."
      gh api -X POST "repos/$repo/actions/runs/$id/rerun-failed-jobs" >/dev/null; retried=1
    else
      echo "The deploy failed twice. The site still shows the previous version."
      echo "Nothing is broken: check githubstatus.com and run ./publish.sh again later."; exit 1
    fi
  fi
  sleep 8
done
echo "Still deploying after 6 minutes. Check the repository's Actions tab."; exit 1
