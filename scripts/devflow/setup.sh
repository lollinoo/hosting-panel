#!/usr/bin/env bash
# First-clone setup and health check: activates the git hooks and verifies that every
# version file in .devflow/packages can be read with its template.
set -euo pipefail
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/scripts/devflow/lib.sh"
cd "$DF_ROOT"

chmod +x .githooks/* scripts/devflow/*.sh 2> /dev/null || true
git config core.hooksPath .githooks
echo "hooks     .githooks (core.hooksPath)"
echo "main      $MAIN_BRANCH"
echo "verify    ${VERIFY_CMD:-<none>}"

fail=0 count=0
while read -r name dir file tpl; do
  count=$((count + 1))
  case $tpl in
    *'{v}'*'{v}'* | '') echo "ERROR     $name: the template needs exactly one {v}: '$tpl'"; fail=1; continue ;;
    *'{v}'*) ;;
    *) echo "ERROR     $name: the template needs exactly one {v}: '$tpl'"; fail=1; continue ;;
  esac
  if [ "$dir" != . ] && [ ! -d "$dir" ]; then echo "ERROR     $name: directory '$dir' not found"; fail=1; fi
  if [ ! -f "$file" ]; then echo "ERROR     $name: $file not found"; fail=1; continue; fi
  if version=$(df_version_in "$(cat "$file")" "$tpl"); then
    echo "package   $name  v$version  ($file)"
  else
    echo "ERROR     $name: template does not match in $file: '$tpl'"
    fail=1
  fi
done < <(df_packages)

if [ $count -eq 0 ]; then echo 'ERROR     .devflow/packages lists no package'; fail=1; fi
if [ ! -f CHANGELOG.md ]; then echo 'warning   CHANGELOG.md is missing (the first release creates it)'; fi
if ! command -v gh > /dev/null 2>&1; then
  echo 'warning   gh CLI not found (needed for issues, PRs and labels)'
elif ! gh auth status > /dev/null 2>&1; then
  echo 'warning   gh is not authenticated (run: gh auth login)'
fi
exit $fail
