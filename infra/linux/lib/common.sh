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

# Features of this release that an older release cannot read (D6). Names match RELEASE.json "features".
# Asks the panel database as hosting_panel (password only in the child's PGPASSWORD, never argv); unlike
# panel_has_admin errors propagate: non-zero = cannot tell. Predicates run only when their migration is recorded.
_hp_features_psql() { # <password> <query>
  PGPASSWORD="$1" psql -X -qtA -v ON_ERROR_STOP=1 -h 127.0.0.1 -U hosting_panel -d hosting_panel -c "$2"
}
panel_features_in_use() { # <api.env>: prints the in-use gated feature names, one per line
  local pw applied out
  [[ "$(env_value "$1" DATABASE_URL)" =~ ^postgresql://hosting_panel:([A-Za-z0-9._~-]+)@127\.0\.0\.1:5432/hosting_panel$ ]] || return 1
  pw="${BASH_REMATCH[1]}"
  applied="$(_hp_features_psql "${pw}" "select filename from public.schema_migrations where filename in ('0021_manual_tls_certificates.sql', '0022_backup_targets_and_copies.sql', '0024_site_templates.sql', '0025_app_stacks.sql', '0029_notifications.sql')")" || return 1
  if grep -qx '0021_manual_tls_certificates.sql' <<<"${applied}"; then
    out="$(_hp_features_psql "${pw}" "select 'manual-tls' where exists (select 1 from public.domains where cert_mode = 'manual')")" || return 1
    [[ -z "${out}" ]] || printf '%s\n' "${out}"
  fi
  if grep -qx '0022_backup_targets_and_copies.sql' <<<"${applied}"; then
    out="$(_hp_features_psql "${pw}" "select 'backup-targets' where exists (select 1 from public.backup_targets where not legacy_settings and archived_at is null)")" || return 1
    [[ -z "${out}" ]] || printf '%s\n' "${out}"
  fi
  if grep -qx '0024_site_templates.sql' <<<"${applied}"; then
    # stv_wordpress_1 = the built-in WordPress version; NULL = legacy site, which an older release handles
    out="$(_hp_features_psql "${pw}" "select 'site-templates' where exists (select 1 from public.sites where template_version_id is not null and template_version_id <> 'stv_wordpress_1')")" || return 1
    [[ -z "${out}" ]] || printf '%s\n' "${out}"
  fi
  if grep -qx '0025_app_stacks.sql' <<<"${applied}"; then
    # a stack that is not deleted (draft included): an older release has no code for it
    out="$(_hp_features_psql "${pw}" "select 'app-stacks' where exists (select 1 from public.app_stacks where deleted_at is null)")" || return 1
    [[ -z "${out}" ]] || printf '%s\n' "${out}"
  fi
  if grep -qx '0029_notifications.sql' <<<"${applied}"; then
    # a channel, on or off: an older release sends nothing, and nobody would be told that the alerts went silent
    out="$(_hp_features_psql "${pw}" "select 'notifications' where exists (select 1 from public.notification_channels)")" || return 1
    [[ -z "${out}" ]] || printf '%s\n' "${out}"
  fi
  return 0
}

# Reads RELEASE.json on stdin; prints its space-separated "features" value (empty when absent).
release_features() {
  sed -n 's/^[[:space:]]*"features":[[:space:]]*"\([a-z0-9 -]*\)".*/\1/p'
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

# Succeeds when the panel ingress is disabled (executor.env HP_PANEL_HOSTNAME empty, as the
# executor reads it) or the hp_ingress_proxy container is running. ${HP_DOCKER_CMD} replaces
# docker for non-root tests only.
panel_proxy_ready() { # <executor.env>
  local host docker=docker
  host="$(env_value "$1" HP_PANEL_HOSTNAME)"
  [[ -n "${host//[[:space:]]/}" ]] || return 0
  ((EUID == 0)) || docker="${HP_DOCKER_CMD:-docker}"
  [[ "$("${docker}" inspect -f '{{.State.Running}}' hp_ingress_proxy 2>/dev/null || true)" == true ]]
}

# Waits up to <timeout> seconds for container <name> to be running. ${HP_DOCKER_CMD} as above.
container_running_within() { # <name> <timeout seconds>
  local deadline=$((SECONDS + $2)) docker=docker
  ((EUID == 0)) || docker="${HP_DOCKER_CMD:-docker}"
  until [[ "$("${docker}" inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" == true ]]; do
    ((SECONDS < deadline)) || return 1
    sleep 3
  done
}

# Waits up to <timeout> seconds for the API readiness probe, the web login page, all four
# panel units active and (panel ingress enabled) hp_ingress_proxy running; gives up early when a
# unit is dead. ${SYSTEMCTL} (default systemctl) is stubbable in tests.
panel_health_check() { # <web bind address> <timeout seconds> [executor.env]
  local deadline=$((SECONDS + $2)) dead env_file="${3:-/etc/hosting-panel/executor.env}"
  printf '  waiting for health (up to %s s)...\n' "$2"
  until curl -fs -o /dev/null --max-time 5 http://127.0.0.1:4000/health/ready &&
    curl -fs -o /dev/null --max-time 5 "http://$1:3000/login" && panel_units_active &&
    panel_proxy_ready "${env_file}"; do
    ((SECONDS < deadline)) || return 1
    if dead="$(panel_dead_unit)"; then
      printf '  %s\n' "${dead}" >&2
      return 1
    fi
    sleep 3
  done
}
