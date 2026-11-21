#!/usr/bin/env bash
# Creates the missing issue/PR labels: type, severity and one svc:<package> per package.
set -euo pipefail
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/scripts/devflow/lib.sh"

existing=$(gh label list --limit 500 --json name --jq '.[].name')
ensure() { # ensure <name> <color> <description>
  if grep -qxF "$1" <<< "$existing"; then return 0; fi
  gh label create "$1" --color "$2" --description "$3"
  existing+="$NL$1"
}

ensure bug d73a4a 'Functional defect or broken behaviour'
ensure enhancement a2eeef 'New feature or improvement'
ensure refactor c5def5 'Code change without behaviour change'
ensure documentation 0075ca 'Documentation, agent rules, templates or process'
ensure performance fbca04 'Speed or resource usage'
ensure broken-code b60205 'Code that cannot work as written'
ensure obsolete-code cfd3d7 'Dead, unreachable or unused code'
ensure duplicated-code e4e669 'Duplicated logic'
ensure 'severity: low' c2e0c6 'Minor impact'
ensure 'severity: medium' fbca04 'Noticeable impact'
ensure 'severity: high' b60205 'Blocks users or risks data'

while read -r name _; do
  ensure "svc:$name" 1d76db "Affects the $name package"
done < <(df_packages)
echo 'labels: OK'
