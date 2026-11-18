#!/usr/bin/env bash
# Post the Quality report on a pull request as one comment, updated in place on every run.
#
#   post-quality-comment.sh <owner/repo> <pr number> <report.md> [expected head sha]
#
# With an expected head sha, posts only if the PR's current head is that commit (the fork path:
# the report came from a run that executed fork code, so it must belong to this PR's head).
# Needs GH_TOKEN with pull-requests: write.
set -euo pipefail

repo=$1
pr=$(printf '%s' "$2" | tr -dc '0-9')
report=$3
expected_sha=${4:-}
marker='<!-- dataflare-quality-report -->'

if [ -z "$pr" ]; then echo "No pull request number."; exit 0; fi
if [ -n "$expected_sha" ]; then
  pr_head=$(gh api "repos/$repo/pulls/$pr" --jq .head.sha)
  if [ "$pr_head" != "$expected_sha" ]; then
    echo "PR #$pr is at $pr_head, not the measured $expected_sha; a newer run will post."
    exit 0
  fi
fi

body=$(mktemp)
head -c 60000 "$report" > "$body"
if ! grep -qF "$marker" "$body"; then echo "Report is missing its marker."; exit 1; fi

existing=$(gh api --paginate "repos/$repo/issues/$pr/comments" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | head -n 1)
if [ -n "$existing" ]; then
  gh api -X PATCH "repos/$repo/issues/comments/$existing" -F body=@"$body" > /dev/null
  echo "Updated comment $existing on #$pr."
else
  gh api -X POST "repos/$repo/issues/$pr/comments" -F body=@"$body" > /dev/null
  echo "Commented on #$pr."
fi
