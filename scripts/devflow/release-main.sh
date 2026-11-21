#!/usr/bin/env bash
# CI release step for the main branch (any CI): bump versions, amend the merge commit
# in place, push it back under a lease and publish a GitHub Release (tag: RELEASE_TAG).
# Needs: full-history checkout, push rights on main, `gh` with GH_TOKEN.
# Outputs build_sha / release_tag / superseded to stdout and to $DEVFLOW_OUTPUT
# (default $GITHUB_OUTPUT). Later jobs must build from build_sha and skip when superseded=true.
set -euo pipefail
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/scripts/devflow/lib.sh"
cd "$DF_ROOT"

OUT_FILE=${DEVFLOW_OUTPUT:-${GITHUB_OUTPUT:-}}
out() {
  echo "$1"
  if [ -n "$OUT_FILE" ]; then echo "$1" >> "$OUT_FILE"; fi
}
finish() { # finish <build_sha> <release_tag> <superseded>
  out "build_sha=$1"
  out "release_tag=$2"
  out "superseded=$3"
  exit 0
}

df_git_auth fetch -q origin "+refs/heads/$MAIN_BRANCH:refs/remotes/origin/$MAIN_BRANCH"
CURRENT=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$MAIN_BRANCH")

# Several merges in a row: only the run on the newest commit releases, covering all of them.
if [ "$REMOTE" != "$CURRENT" ]; then
  echo "Notice: origin/$MAIN_BRANCH ($REMOTE) advanced past $CURRENT; deferring to the latest queued run."
  finish "$CURRENT" '' true
fi

# Re-run on a commit that is already the release baseline: nothing new to release.
if [ "$(df_release_base)" = "$CURRENT" ]; then
  echo "Notice: $CURRENT is already released; nothing to do."
  finish "$CURRENT" '' false
fi

git checkout -q -B "$MAIN_BRANCH" "$CURRENT"
NOTES=$(mktemp)
trap 'rm -f "$NOTES"' EXIT
bash "$DF_DIR/bump-version.sh" --amend-head --release-notes-out "$NOTES"
NEW=$(git rev-parse HEAD)

if [ "$NEW" != "$CURRENT" ]; then
  if [ -z "${GITHUB_ACTIONS:-}" ] && ! git log -1 --format=%B | grep -qiE '\[(skip ci|ci skip)\]'; then
    # The push below comes back as a webhook: without this an external CI would run again.
    author_name=$(git log -1 --format=%an) author_email=$(git log -1 --format=%ae)
    ALLOW_MAIN_COMMIT=1 GIT_COMMITTER_NAME=$author_name GIT_COMMITTER_EMAIL=$author_email \
      git commit --amend --no-verify -q -m "$(git log -1 --format=%B)" -m '[skip ci]'
    NEW=$(git rev-parse HEAD)
  fi
  echo "Pushing amended commit $NEW to $MAIN_BRANCH..."
  if ! df_git_auth push --force-with-lease="refs/heads/$MAIN_BRANCH:$CURRENT" origin "HEAD:refs/heads/$MAIN_BRANCH"; then
    echo "Notice: origin/$MAIN_BRANCH advanced during the push; deferring to the latest queued run."
    finish "$CURRENT" '' true
  fi
fi

TAG=$(df_release_tag)
printf '\n---\n\nCommit: `%s`\n' "$NEW" >> "$NOTES"
# A draft is published later by the project's own job (e.g. after it uploads the build).
if [ "$RELEASE_DRAFT" = true ]; then latest=--draft; else latest=--latest; fi
if gh release view "$TAG" > /dev/null 2>&1; then
  if [ -n "$RELEASE_TAG" ]; then
    # A versioned tag that already exists belongs to an older release: never rewrite it.
    echo "ERROR: release $TAG already exists; the first package in .devflow/packages was not bumped." >&2
    exit 1
  fi
  gh release edit "$TAG" --title "$TAG" --notes-file "$NOTES" "$latest"
else
  gh release create "$TAG" --target "$NEW" --title "$TAG" --notes-file "$NOTES" "$latest"
fi
echo "Published GitHub Release $TAG ($NEW)"
finish "$NEW" "$TAG" false
