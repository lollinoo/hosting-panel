#!/usr/bin/env bash
# Post-merge version bumper. From the Conventional Commits since the last release it
# derives one SemVer bump per package (type!: / a BREAKING CHANGE: footer → major, feat → minor,
# anything else → patch), rewrites the version files and prepends CHANGELOG.md.
#
# Usage: bump-version.sh [--dry-run] [--amend-head] [--release-notes-out <file>]
#                        [--since <ref>] [--allow-branch]
set -euo pipefail
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/scripts/devflow/lib.sh"
cd "$DF_ROOT"

DRY=0 AMEND=0 ALLOW=0 NOTES_OUT='' SINCE=''
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --amend-head) AMEND=1 ;;
    --allow-branch) ALLOW=1 ;;
    --release-notes-out) NOTES_OUT=${2:?missing file}; shift ;;
    --since) SINCE=${2:?missing ref}; shift ;;
    *) echo "bump-version: unknown argument '$1'" >&2; exit 1 ;;
  esac
  shift
done

BRANCH=$(git symbolic-ref --short -q HEAD || true)
if [ $DRY -eq 0 ] && [ $ALLOW -eq 0 ] && [ "$BRANCH" != "$MAIN_BRANCH" ]; then
  echo "bump-version: ERROR — version bumps are forbidden on '${BRANCH:-detached HEAD}'." >&2
  echo "  They happen automatically after the merge on '$MAIN_BRANCH'. Preview with --dry-run." >&2
  exit 1
fi

# Base of the release range: explicit, the branch point (previews), or the last release.
BASE=$SINCE
if [ -z "$BASE" ] && [ -n "$BRANCH" ] && [ "$BRANCH" != "$MAIN_BRANCH" ]; then BASE=$(df_closest_base || true); fi
if [ -z "$BASE" ]; then BASE=$(df_release_base); fi
if [ -z "$BASE" ]; then BASE=$(git rev-parse -q --verify HEAD~1 2> /dev/null || git rev-parse HEAD); fi

# Packages as parallel arrays (bash 3.2 has no associative arrays). The first line of a
# package is its source of truth; further lines are extra files kept in sync.
P_NAME=() P_DIR=() P_FILE=() P_TPL=() P_LEVEL=() P_CUR=() P_FROM=() P_TO=() P_NEW=()
while read -r name dir file tpl; do
  known=0
  for ((i = 0; i < ${#P_NAME[@]}; i++)); do
    if [ "${P_NAME[i]}" = "$name" ]; then known=1; fi
  done
  if [ $known -eq 0 ]; then
    if ! cur=$(df_version_in "$(cat "$file" 2> /dev/null)" "$tpl"); then
      echo "bump-version: ERROR — cannot read the version of '$name' from $file (template: $tpl)" >&2
      exit 1
    fi
    P_NAME+=("$name") P_DIR+=("${dir%/}") P_FILE+=("$file") P_TPL+=("$tpl")
    P_LEVEL+=(0) P_CUR+=("$cur") P_FROM+=("$cur") P_TO+=("$cur") P_NEW+=(0)
  fi
done < <(df_packages)

# Highest level per package across every commit of the range (1 patch, 2 minor, 3 major).
RE_BREAK='^[a-z]+(\([^)]+\))?!:'
RE_FEAT='^feat(\([^)]+\))?:'
LEVEL_NAME=(none patch minor major)
RELEVANT='' # commits that change at least one file outside BUMP_IGNORE
while read -r sha; do
  subject=$(git log -1 --format=%s "$sha")
  case $subject in 'chore(release):'*) continue ;; esac
  level=1
  if [[ $subject =~ $RE_BREAK ]] || git log -1 --format=%b "$sha" | grep -qE '^BREAKING[ -]CHANGE:'; then
    level=3
  elif [[ $subject =~ $RE_FEAT ]]; then
    level=2
  fi
  while read -r f; do
    if df_bump_ignored "$f"; then continue; fi
    case $RELEVANT in *"$sha"*) ;; *) RELEVANT+="$sha$NL" ;; esac
    for ((i = 0; i < ${#P_NAME[@]}; i++)); do
      d=${P_DIR[i]}
      if [ "$d" = . ] || [ "${f#"$d"/}" != "$f" ]; then
        if [ "$level" -gt "${P_LEVEL[i]}" ]; then P_LEVEL[i]=$level; fi
      fi
    done
  done < <(git -c core.quotepath=off diff-tree --no-commit-id --name-only -r "$sha")
done < <(git rev-list --no-merges "$BASE..HEAD")

# Compute and apply the transitions.
COUNT=0 SUBTITLE='' BUMP_LINES='' SUMMARY='' STAGE=(CHANGELOG.md)
for ((i = 0; i < ${#P_NAME[@]}; i++)); do
  level=${P_LEVEL[i]}
  if [ "$level" -eq 0 ]; then continue; fi
  name=${P_NAME[i]}
  if base_content=$(git show "$BASE:${P_FILE[i]}" 2> /dev/null) && from=$(df_version_in "$base_content" "${P_TPL[i]}"); then
    IFS=. read -r major minor patch <<< "$from"
    case $level in
      3) to="$((10#$major + 1)).0.0" ;;
      2) to="$major.$((10#$minor + 1)).0" ;;
      *) to="$major.$minor.$((10#$patch + 1))" ;;
    esac
    BUMP_LINES+="- **\`$name\`**: \`v$from\` → **\`v$to\`** (${LEVEL_NAME[level]})$NL"
  else
    # Package added in this range: it keeps the version it ships with.
    from=${P_CUR[i]} to=${P_CUR[i]}
    P_NEW[i]=1
    BUMP_LINES+="- **\`$name\`**: newly added (**\`v$to\`**)$NL"
  fi
  P_FROM[i]=$from
  P_TO[i]=$to
  COUNT=$((COUNT + 1))
  SUBTITLE+="${SUBTITLE:+ · }$name v$to"
  SUMMARY+="  - $name: v$from -> v$to$NL"

  if [ $DRY -eq 0 ] && [ "${P_NEW[i]}" -eq 0 ]; then
    while read -r n _ f tpl; do
      if [ "$n" != "$name" ] || [ ! -f "$f" ]; then continue; fi
      if df_set_version "$f" "$tpl" "$to"; then
        STAGE+=("$f")
      else
        echo "bump-version: WARNING — template did not match in $f, left unchanged ($tpl)" >&2
      fi
    done < <(df_packages)
  fi
done

# Release title and notes from the commit subjects of the range.
RE_CC="^($DF_TYPES)(\\(([^)]+)\\))?!?: (.+)\$"
RE_PR='^(.*[^[:space:]])[[:space:]]*\(#[0-9]+\)$'
FEAT='' FIX='' PERF='' OTHER='' H_FEAT='' H_MAIN='' H_ANY=''
while read -r sha s; do
  case $s in '' | 'chore(release):'*) continue ;; esac
  case $RELEVANT in *"$sha"*) ;; *) continue ;; esac # only BUMP_IGNORE paths: not in the notes
  if [[ $s =~ $RE_CC ]]; then
    type=${BASH_REMATCH[1]} scope=${BASH_REMATCH[3]:-} desc=${BASH_REMATCH[4]}
    if [[ $desc =~ $RE_PR ]]; then desc=${BASH_REMATCH[1]}; fi
    desc="$(printf '%s' "${desc:0:1}" | tr '[:lower:]' '[:upper:]')${desc:1}"
    if [ -n "$scope" ]; then bullet="- **$scope**: $desc$NL"; else bullet="- $desc$NL"; fi
    if [ -z "$H_ANY" ]; then H_ANY=$desc; fi
    case $type in
      feat)
        FEAT+=$bullet
        if [ -z "$H_FEAT" ]; then H_FEAT=$desc; fi
        if [ -z "$H_MAIN" ]; then H_MAIN=$desc; fi
        ;;
      fix)
        FIX+=$bullet
        if [ -z "$H_MAIN" ]; then H_MAIN=$desc; fi
        ;;
      perf)
        PERF+=$bullet
        if [ -z "$H_MAIN" ]; then H_MAIN=$desc; fi
        ;;
      refactor) PERF+=$bullet ;;
      *) OTHER+=$bullet ;;
    esac
  else
    OTHER+="- $s$NL"
  fi
done < <(git log --reverse --no-merges --format='%H %s' "$BASE..HEAD")

NOTES=''
section() {
  if [ -n "$2" ]; then NOTES+="${NOTES:+$NL}**$1**$NL$2"; fi
}
section 'New Features' "$FEAT"
section 'Bug Fixes & Stability' "$FIX"
section 'Performance & Refactoring' "$PERF"
section 'Maintenance, CI & Documentation' "$OTHER"
NOTES=${NOTES%"$NL"}

TITLE=${H_FEAT:-${H_MAIN:-${H_ANY:-Update ${SUBTITLE// · /, }}}}
TODAY=$(TZ="$RELEASE_TZ" date +%Y-%m-%d)
ENTRY=''
if [ $COUNT -gt 0 ]; then ENTRY="### $TITLE ($TODAY)$NL*$SUBTITLE*$NL$NL${NOTES:-Maintenance release.}"; fi

if [ -n "$NOTES_OUT" ]; then
  {
    echo "### Touched packages ($COUNT)"
    if [ $COUNT -gt 0 ]; then
      printf '%s' "$BUMP_LINES"
      printf '\n---\n\n%s\n' "$ENTRY"
    else
      echo '- _No package version bumps (CI / infrastructure / tooling update)_'
    fi
    printf '\n---\n\n### Versions\n| Package | Version | Status |\n|---|---|---|\n'
    for ((i = 0; i < ${#P_NAME[@]}; i++)); do
      if [ "${P_LEVEL[i]}" -eq 0 ]; then
        status=Unchanged
      elif [ "${P_NEW[i]}" -eq 1 ]; then
        status=Added
      else
        status="Updated (\`v${P_FROM[i]}\` → \`v${P_TO[i]}\`)"
      fi
      echo "| \`${P_NAME[i]}\` | \`v${P_TO[i]}\` | $status |"
    done
  } > "$NOTES_OUT"
fi

if [ $COUNT -eq 0 ]; then
  echo 'No package bumps detected.'
  exit 0
fi

# Newest entry first: after the header separator when there is one, else above the first entry.
write_changelog() {
  local content sep head tail
  if [ ! -f CHANGELOG.md ]; then printf '# Changelog\n\n---\n' > CHANGELOG.md; fi
  content=$(cat CHANGELOG.md; printf x)
  content=${content%x}
  sep="$NL---$NL"
  case $content in
    *"$sep"*)
      head=${content%%"$sep"*} tail=${content#*"$sep"}
      printf '%s%s\n%s\n\n---\n%s' "$head" "$sep" "$ENTRY" "$tail" > CHANGELOG.md
      ;;
    *"$NL##"*)
      head=${content%%"$NL##"*} tail=${content#*"$NL##"}
      printf '%s\n%s\n\n##%s' "$head" "$ENTRY" "$tail" > CHANGELOG.md
      ;;
    *) printf '%s\n%s\n' "$content" "$ENTRY" > CHANGELOG.md ;;
  esac
}

if [ $DRY -eq 1 ]; then
  echo "=== DRY RUN: planned version bumps (base: ${BASE:0:7}) ==="
  printf '%s' "$SUMMARY"
  printf '\n=== CHANGELOG.md entry preview ===\n%s\n' "$ENTRY"
  exit 0
fi

write_changelog
echo '=== Applied version bumps ==='
printf '%s' "$SUMMARY"

if [ $AMEND -eq 1 ]; then
  git add -- "${STAGE[@]}"
  # Keep the developer as author and committer: no extra bot commit on main.
  author_name=$(git log -1 --format=%an) author_email=$(git log -1 --format=%ae)
  ALLOW_MAIN_COMMIT=1 GIT_COMMITTER_NAME=$author_name GIT_COMMITTER_EMAIL=$author_email \
    git commit --amend --no-edit --no-verify -q
  echo "Amended HEAD in place (author: $author_name) with: ${SUBTITLE// · /, }"
fi
