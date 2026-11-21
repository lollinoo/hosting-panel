#!/usr/bin/env bash
# PR gate: Conventional Commit subjects and PR title, no version / CHANGELOG edits on the branch.
# Env: BASE_REF (default origin/<main>), PR_TITLE (optional, linted when set), PR_BODY (optional:
# when set, even empty, it must close an issue with a GitHub keyword such as "Closes #12", keep
# no template <!-- hints --> and stay within PR_BODY_MAX characters).
set -euo pipefail
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/scripts/devflow/lib.sh"
cd "$DF_ROOT"

BASE_REF=${BASE_REF:-origin/$MAIN_BRANCH}
if ! git rev-parse -q --verify "$BASE_REF" > /dev/null 2>&1; then
  df_git_auth fetch -q origin "+refs/heads/$MAIN_BRANCH:refs/remotes/origin/$MAIN_BRANCH"
fi
# After merging main into the branch the merge-base moves up, so versions carried by main are not a bump here.
MB=$(git merge-base "$BASE_REF" HEAD)

fail=0
err() {
  echo "check-pr: ERROR — $*" >&2
  fail=1
}

while read -r s; do
  case $s in '' | 'Merge '* | 'Revert '*) continue ;; esac
  if ! [[ $s =~ $DF_CC_REGEX ]]; then err "commit subject is not a Conventional Commit: $s"; fi
done < <(git log --no-merges --format=%s "$MB..HEAD")

# The PR title becomes the squash commit on main and drives the version bump.
if [ -n "${PR_TITLE:-}" ] && ! [[ $PR_TITLE =~ $DF_CC_REGEX ]]; then
  err "PR title is not a Conventional Commit (<type>(<scope>): <description>): $PR_TITLE"
fi

# Issue first: the PR closes its tracking issue, so the merge closes it too.
DF_CLOSES_REGEX='(^|[^[:alnum:]])([Cc]lose[sd]?|[Ff]ix(e[sd])?|[Rr]esolve[sd]?):?[[:space:]]+([[:alnum:]_.-]+/[[:alnum:]_.-]+)?#[0-9]+'
if [ -n "${PR_BODY+set}" ] && ! [[ $PR_BODY =~ $DF_CLOSES_REGEX ]]; then
  err 'PR description does not close an issue: start it with "Closes #<issue>" (every PR starts from an issue).'
fi
# The description becomes the body of the squash commit on the main branch.
if [ -n "${PR_BODY+set}" ]; then
  case $PR_BODY in *'<!--'*) err 'PR description still has template <!-- hints -->: replace them with the content, or delete them.' ;; esac
  if [ "${PR_BODY_MAX:-0}" -gt 0 ] && [ "${#PR_BODY}" -gt "$PR_BODY_MAX" ]; then
    err "PR description is ${#PR_BODY} characters, the limit is $PR_BODY_MAX (PR_BODY_MAX): keep Why, What and Verified short."
  fi
fi

while read -r _ _ file tpl; do
  old=$(git show "$MB:$file" 2> /dev/null) || continue
  new=$(git show "HEAD:$file" 2> /dev/null) || continue
  old_version=$(df_version_in "$old" "$tpl") || continue
  new_version=$(df_version_in "$new" "$tpl") || continue
  if [ "$old_version" != "$new_version" ]; then
    err "$file: version changed $old_version -> $new_version on a branch (bumps happen automatically after the merge)."
  fi
done < <(df_packages)

if git cat-file -e "$MB:CHANGELOG.md" 2> /dev/null && ! git diff --quiet "$MB" HEAD -- CHANGELOG.md; then
  err 'CHANGELOG.md changed on a branch (it is written automatically after the merge).'
fi

if [ $fail -eq 0 ]; then echo 'check-pr: OK'; fi
exit $fail
