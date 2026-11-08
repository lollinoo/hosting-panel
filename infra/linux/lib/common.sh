#!/usr/bin/env bash
# Helpers shared by install.sh and update.sh. Source this file; functions return non-zero, never exit.

env_value() { # env_value <file> <KEY>: prints the value (for internal use only, never echoed)
  local line
  [[ -r "$1" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == "$2="* ]] && printf '%s' "${line#"$2="}"
  done <"$1"
  return 0
}

# Prints the latest GitHub release version (x.y.z); non-zero if it cannot be determined.
latest_release_version() {
  local v
  v="$(curl -fsSL --retry 3 --connect-timeout 15 \
    "https://api.github.com/repos/${HP_RELEASE_REPO:-lollinoo/hosting-panel}/releases/latest" |
    sed -n 's/.*"tag_name": *"v\([0-9.]*\)".*/\1/p' | head -n1)" || return 1
  [[ "${v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s\n' "${v}"
}

# Waits up to <timeout> seconds for the API readiness probe and the web login page; gives up
# early if hp-api or hp-web has failed. ${SYSTEMCTL} (default systemctl) is stubbable in tests.
panel_health_check() { # <web bind address> <timeout seconds>
  local deadline=$((SECONDS + $2))
  printf '  waiting for health (up to %s s)...\n' "$2"
  until curl -fs -o /dev/null --max-time 5 http://127.0.0.1:4000/health/ready &&
    curl -fs -o /dev/null --max-time 5 "http://$1:3000/login"; do
    ((SECONDS < deadline)) || return 1
    ! "${SYSTEMCTL:-systemctl}" is-failed --quiet hp-api hp-web || { printf '  hp-api or hp-web has failed\n' >&2; return 1; }
    sleep 3
  done
}
