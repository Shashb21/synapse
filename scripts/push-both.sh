#!/usr/bin/env bash
# Push the current branch to Origin and GitHub. GitHub is the public share
# surface; Origin has no public visibility in the current beta (Internal / Private).
set -euo pipefail

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  echo "Not on a branch." >&2
  exit 1
fi

echo "→ Origin (origin) $branch"
git push -u origin "$branch"

if git remote get-url github >/dev/null 2>&1; then
  echo "→ GitHub (github) $branch"
  git push -u github "$branch"
else
  echo "No 'github' remote. Add:" >&2
  echo "  git remote add github https://github.com/Shashb21/synapse.git" >&2
  exit 1
fi
