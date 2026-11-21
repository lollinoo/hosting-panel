#!/usr/bin/env bash
# devflow shared helpers, sourced by the hooks and scripts. Needs only bash (3.2+) and git.

DF_ROOT=$(git rev-parse --show-toplevel)
DF_DIR=$DF_ROOT/scripts/devflow
NL=$'\n'

MAIN_BRANCH=main
VERIFY_CMD=
PUSH_VERIFY_CMD=
PR_BODY_MAX=1000
RELEASE_TZ=UTC
RELEASE_TAG=
RELEASE_DRAFT=false
# shellcheck disable=SC1091
if [ -f "$DF_ROOT/.devflow/config" ]; then . "$DF_ROOT/.devflow/config"; fi

DF_TYPES='feat|fix|refactor|perf|docs|style|test|chore|ci|build'
DF_CC_REGEX="^($DF_TYPES)(\\([a-z0-9_/-]+\\))?!?: .+"
DF_BRANCH_REGEX="^($DF_TYPES)/[a-z0-9._-]+\$"

# Prints the entries of .devflow/packages: <package> <dir> <version-file> <template...>
df_packages() {
  [ -f "$DF_ROOT/.devflow/packages" ] || return 0
  tr -d '\r' < "$DF_ROOT/.devflow/packages" | grep -vE '^[[:space:]]*(#|$)' || true
}

# Turns a version template into an ERE with the groups (prefix)(X.Y.Z)(suffix).
# {v} is the version, a leading ^ anchors to a line start, a whitespace run matches
# any whitespace (newlines included), everything else is literal.
df_regex() {
  local t=$1 out='(' c i
  if [ "${t:0:1}" = '^' ]; then
    out+="(^|$NL)"
    t=${t:1}
  fi
  for ((i = 0; i < ${#t}; i++)); do
    if [ "${t:i:3}" = '{v}' ]; then
      out+=')([0-9]+\.[0-9]+\.[0-9]+)('
      i=$((i + 2))
      continue
    fi
    c=${t:i:1}
    case $c in
      ' ' | $'\t') case $out in *'[[:space:]]+') ;; *) out+='[[:space:]]+' ;; esac ;;
      '\' | . | '[' | ']' | '(' | ')' | '*' | + | '?' | '{' | '}' | '|' | '^' | '$') out+="\\$c" ;;
      *) out+=$c ;;
    esac
  done
  printf '%s)' "$out"
}

# df_version_in <content> <template>: prints the version, fails when the template does not match.
df_version_in() {
  local re n
  re=$(df_regex "$2")
  [[ $1 =~ $re ]] || return 1
  n=${#BASH_REMATCH[@]}
  printf '%s\n' "${BASH_REMATCH[n - 2]}"
}

# df_set_version <file> <template> <new-version>: rewrites the first match in place.
df_set_version() {
  local content re n m new_m
  content=$(cat "$1"; printf x)
  content=${content%x}
  re=$(df_regex "$2")
  [[ $content =~ $re ]] || return 1
  n=${#BASH_REMATCH[@]}
  m=${BASH_REMATCH[0]}
  new_m=${BASH_REMATCH[1]}$3${BASH_REMATCH[n - 1]}
  content=${content/"$m"/"$new_m"}
  printf '%s' "$content" > "$1"
}

# Merge-base of <tip> (default HEAD) with the closest main ref.
df_closest_base() {
  local tip=${1:-HEAD} best='' min=999999 c mb d
  for c in "upstream/$MAIN_BRANCH" "origin/$MAIN_BRANCH" "$MAIN_BRANCH"; do
    git rev-parse -q --verify "$c" > /dev/null 2>&1 || continue
    mb=$(git merge-base "$c" "$tip" 2> /dev/null) || continue
    d=$(git rev-list --count "$mb..HEAD")
    if [ "$d" -lt "$min" ]; then
      min=$d
      best=$mb
    fi
  done
  [ -n "$best" ] || return 1
  printf '%s\n' "$best"
}

# Last release commit: the newest of "last commit touching CHANGELOG.md" and
# "commit that installed devflow" (so an old changelog never becomes the baseline).
df_release_base() {
  local a b
  a=$(git log -n 1 --first-parent --format=%H -- CHANGELOG.md)
  b=$(git log -n 1 --first-parent --diff-filter=A --format=%H -- .devflow/config)
  if [ -n "$a" ] && [ -n "$b" ]; then
    if git merge-base --is-ancestor "$a" "$b"; then echo "$b"; else echo "$a"; fi
  else
    echo "${a:-$b}"
  fi
}

# Tag of the GitHub Release: RELEASE_TAG with {version} replaced by the version of the first
# package in .devflow/packages (e.g. v{version}), or a timestamp YYYYMMDD-HHMM when it is empty.
df_release_tag() {
  if [ -z "$RELEASE_TAG" ]; then
    TZ="$RELEASE_TZ" date +%Y%m%d-%H%M
    return
  fi
  local name dir file tpl v
  read -r name dir file tpl <<< "$(df_packages | head -n 1)"
  if [ -z "$file" ] || ! v=$(df_version_in "$(cat "$DF_ROOT/$file" 2> /dev/null)" "$tpl"); then
    echo "devflow: RELEASE_TAG needs the version of the first package in .devflow/packages" >&2
    return 1
  fi
  printf '%s\n' "${RELEASE_TAG//\{version\}/$v}"
}

# git with GH_TOKEN auth outside GitHub Actions (there actions/checkout already persists credentials).
df_git_auth() {
  if [ -n "${GH_TOKEN:-}" ] && [ -z "${GITHUB_ACTIONS:-}" ]; then
    local b64
    b64=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $b64" "$@"
  else
    git "$@"
  fi
}

# Runs the project's own hook (.githooks/<name>.local), if any, after the devflow checks.
df_local_hook() {
  local hook=$DF_ROOT/.githooks/$1.local
  shift
  if [ -x "$hook" ]; then "$hook" "$@"; fi
}
