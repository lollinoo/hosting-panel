#!/usr/bin/env bash
# Starts the work on an issue in one step: refuses an issue that already has an open PR,
# creates the branch (or a sibling worktree) from the freshly fetched main branch, pushes an
# empty start commit, opens the draft PR with the issue's labels and assigns both to you.
#
# Usage: start.sh <issue-number> "<type>(<scope>): <description>" [--worktree]
#   The second argument is the PR title; the branch name is derived from it.
set -euo pipefail
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/scripts/devflow/lib.sh"
cd "$DF_ROOT"

die() {
  echo "start: ERROR — $*" >&2
  exit 1
}

ISSUE=${1:-} TITLE=${2:-} WORKTREE=${3:-}
if ! [[ $ISSUE =~ ^[0-9]+$ ]] || [ -z "$TITLE" ] || [ $# -gt 3 ] || { [ -n "$WORKTREE" ] && [ "$WORKTREE" != --worktree ]; }; then
  die 'usage: start.sh <issue-number> "<type>(<scope>): <description>" [--worktree]'
fi
# Same shape as DF_CC_REGEX, with groups for type, scope and description.
RE_TITLE="^($DF_TYPES)(\\(([a-z0-9_/-]+)\\))?!?: (.+)\$"
if ! [[ $TITLE =~ $RE_TITLE ]]; then
  die "the PR title is not a Conventional Commit (<type>(<scope>): <description>): $TITLE"
fi
type=${BASH_REMATCH[1]} scope=${BASH_REMATCH[3]} desc=${BASH_REMATCH[4]}
slug=$(printf '%s' "${scope:+$scope-}$desc" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-50 | sed 's/^-*//; s/-*$//')
BRANCH=$type/$slug
if ! [[ $BRANCH =~ $DF_BRANCH_REGEX ]]; then die "cannot derive a branch name from: $TITLE"; fi
if [ -z "$WORKTREE" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die 'uncommitted changes in this checkout: commit or stash them, or use --worktree.'
fi

# An open PR that closes the issue means someone is already on it.
info=$(gh issue view "$ISSUE" --json state,labels --jq '.state, .labels[].name')
if [ "${info%%"$NL"*}" != OPEN ]; then die "issue #$ISSUE is not open."; fi
prs=$(gh pr list --state open --limit 500 --json number,body \
  --jq '.[] | select((.body // "") | test("(?i)\\b(close[sd]?|fix(e[sd])?|resolve[sd]?):? #'"$ISSUE"'\\b")) | .number')
if [ -n "$prs" ]; then
  die "issue #$ISSUE already has an open PR (#${prs//$NL/, #}): continue there, or pick another issue."
fi

# Always start from origin: the local main branch may be stale or diverged by the release amend.
df_git_auth fetch -q origin "+refs/heads/$MAIN_BRANCH:refs/remotes/origin/$MAIN_BRANCH"
if df_git_auth ls-remote --exit-code origin "refs/heads/$BRANCH" > /dev/null; then
  die "branch '$BRANCH' already exists on origin."
fi
DIR=$DF_ROOT
if [ -n "$WORKTREE" ]; then
  DIR=$(git worktree list --porcelain | sed -n '1s/^worktree //p')-${BRANCH//\//-}
  git worktree add -q --no-track -b "$BRANCH" "$DIR" "origin/$MAIN_BRANCH"
  cd "$DIR"
else
  git switch -q --no-track -c "$BRANCH" "origin/$MAIN_BRANCH"
fi

git commit -q --allow-empty -m "$type${scope:+($scope)}: start $desc (#$ISSUE)"
# The start commit is empty on top of the fetched main: nothing for pre-push to verify yet.
git push -q --no-verify -u origin HEAD

body="Closes #$ISSUE$NL"
if [ -f .github/PULL_REQUEST_TEMPLATE.md ]; then body+=$(grep -v '^Closes #' .github/PULL_REQUEST_TEMPLATE.md || true); fi
labels=()
while read -r label; do
  case $label in '' | 'severity: '*) ;; *) labels+=(--label "$label") ;; esac
done < <(tail -n +2 <<< "$info")
gh pr create --draft --assignee @me --base "$MAIN_BRANCH" --head "$BRANCH" \
  --title "$TITLE" --body "$body" ${labels[@]+"${labels[@]}"}
gh issue edit "$ISSUE" --add-assignee @me > /dev/null
echo "start: on $BRANCH${WORKTREE:+ in the worktree $DIR}"
