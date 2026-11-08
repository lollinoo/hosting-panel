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

HP_PANEL_UNITS=(hp-host-agent hp-docker-executor hp-api hp-web)

# systemctl is-active with several units succeeds if ANY is active, so check one by one.
panel_units_active() {
  local u
  for u in "${HP_PANEL_UNITS[@]}"; do
    "${SYSTEMCTL:-systemctl}" is-active --quiet "${u}" || return 1
  done
}

# Prints the first dead panel unit and succeeds; fails if none is dead. Dead = failed, or
# crash-looping: a unit with Restart= sits in activating/auto-restart and never reaches "failed".
panel_dead_unit() {
  local u state
  for u in "${HP_PANEL_UNITS[@]}"; do
    "${SYSTEMCTL:-systemctl}" is-failed --quiet "${u}" && { printf '%s failed\n' "${u}"; return 0; }
    state="$("${SYSTEMCTL:-systemctl}" show -p ActiveState,SubState --value "${u}" 2>/dev/null | paste -sd' ')" || state=""
    [[ "${state}" == "activating auto-restart" ]] && { printf '%s is crash-looping\n' "${u}"; return 0; }
  done
  return 1
}

# Waits up to <timeout> seconds for the API readiness probe, the web login page and all four
# panel units active; gives up early when a unit is dead. ${SYSTEMCTL} (default systemctl) is
# stubbable in tests.
panel_health_check() { # <web bind address> <timeout seconds>
  local deadline=$((SECONDS + $2)) dead
  printf '  waiting for health (up to %s s)...\n' "$2"
  until curl -fs -o /dev/null --max-time 5 http://127.0.0.1:4000/health/ready &&
    curl -fs -o /dev/null --max-time 5 "http://$1:3000/login" && panel_units_active; do
    ((SECONDS < deadline)) || return 1
    if dead="$(panel_dead_unit)"; then
      printf '  %s\n' "${dead}" >&2
      return 1
    fi
    sleep 3
  done
}
