#!/usr/bin/env bash
# Push the current branch to Cursor Origin and to public GitHub.
# Origin has no public visibility; GitHub is the share URL.
set -euo pipefail

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  echo "Not on a branch." >&2
  exit 1
fi

if ! git remote get-url github >/dev/null 2>&1; then
  git remote add github https://github.com/Shashb21/synapse.git
fi

echo "→ Origin (origin) $branch"
git push -u origin "$branch"

echo "→ GitHub (github) $branch"
git push -u github "$branch"
