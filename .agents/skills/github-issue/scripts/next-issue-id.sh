#!/usr/bin/env bash
# Prints the next sequential issue identifier for a prefix (BUG, FEAT, CI, OBS, DUP, DOCS),
# scanning the titles of open and closed issues. Without argument, prints it for every prefix.
#
# --claim <N>: run right after creating issue #N. Agents creating issues in parallel can get
# the same ID; the lowest issue number keeps it and #N is retitled with the next free one.
set -euo pipefail

# Every issue as "<number>\t<title>".
issues() {
  gh issue list --limit 1000 --state all --json number,title --jq '.[] | "\(.number)\t\(.title)"'
}

# next_id <prefix>, reading issues() lines on stdin.
next_id() {
  awk -F'\t' -v p="$1" '
    match($2, "^\\[" p "-[0-9]+\\]") { n = substr($2, length(p) + 3, RLENGTH - length(p) - 3) + 0; if (n > max) max = n }
    END { printf "%s-%02d\n", p, max + 1 }'
}

claim() {
  local n=$1 list title id prefix dup new try
  for try in 1 2 3 4 5; do
    list=$(issues)
    title=$(awk -F'\t' -v n="$n" '$1 == n { print $2; exit }' <<< "$list")
    if ! [[ $title =~ ^\[([A-Z]+)-[0-9]+\] ]]; then
      echo "next-issue-id: issue #$n has no [PREFIX-NN] title: '$title'" >&2
      return 1
    fi
    id=${BASH_REMATCH[0]} prefix=${BASH_REMATCH[1]}
    dup=$(awk -F'\t' -v n="$n" -v id="$id" '$1 + 0 < n + 0 && index($2, id) == 1 { print $1; exit }' <<< "$list")
    if [ -z "$dup" ]; then
      printf '%s\n' "${id:1:${#id}-2}"
      return 0
    fi
    new=$(next_id "$prefix" <<< "$list")
    gh issue edit "$n" --title "[$new]${title#"$id"}" > /dev/null
    echo "next-issue-id: $id already belongs to #$dup, #$n retitled to [$new] (attempt $try)" >&2
  done
  echo "next-issue-id: could not claim a unique ID for #$n" >&2
  return 1
}

case ${1:-} in
  --claim) claim "${2:?usage: next-issue-id.sh --claim <issue-number>}" ;;
  '')
    list=$(issues)
    for prefix in BUG FEAT CI OBS DUP DOCS; do next_id "$prefix" <<< "$list"; done
    ;;
  *) issues | next_id "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')" ;;
esac
