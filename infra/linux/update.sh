#!/usr/bin/env bash
# ==============================================================================
# Hosting Panel — updater with health check and automatic rollback.
# Installed as /usr/local/sbin/hp-update (a wrapper that runs the current release's copy).
# Never touches docker.service, containers, the ingress proxy or nftables.
# ==============================================================================

usage() {
  cat <<'EOF'
Usage: sudo hp-update [--version <v> | --archive <path>] [--allow-downgrade] [--dry-run]
                      [--allow-other-linux]

  --version          Release to install (default: latest GitHub release).
  --archive          Local hosting-panel-<v>-linux-x64.tar.gz (its .sha256 must sit next to it).
  --allow-downgrade  Allow installing a version older than the current one.
  --allow-other-linux  Pass through to bootstrap-dedicated.sh (lab hosts installed with it).
  --dry-run          Print the plan; changes nothing, needs neither root nor network.

Exit codes: 0 ok (or already up to date), 1 step failed or another update is running,
2 bad arguments or downgrade refused, 4 checksum failure,
6 new release unhealthy: rolled back, 7 rollback unhealthy too.
EOF
}

# Resolved through symlinks so the libraries come from the same release as this script.
SCRIPT_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
# shellcheck source=lib/release.sh
. "${SCRIPT_DIR}/lib/release.sh"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

UNITS=(hp-host-agent hp-docker-executor hp-api hp-web)
DOWNLOAD_DIR="" # private mktemp -d dir (0700), removed on every exit
STEP=0
STEP_NAME=""
TOTAL=9

die() { # die <code> <message>
  printf '[ERROR] %s\n' "$2" >&2
  exit "$1"
}
step() {
  STEP="$1"
  STEP_NAME="$2"
  printf '\n[STEP %s/%s] %s\n' "$STEP" "$TOTAL" "$STEP_NAME"
}
plan() { printf '  [DRY-RUN] %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

on_exit() {
  local rc=$?
  [[ -z "${DOWNLOAD_DIR}" ]] || rm -rf -- "${DOWNLOAD_DIR}"
  if ((rc != 0 && STEP > 0)); then
    printf '\n[ERROR] Step %s/%s (%s) ended with exit code %s.\n' "${STEP}" "${TOTAL}" "${STEP_NAME}" "${rc}" >&2
  fi
}

# Test overrides (stubs). Only honoured as non-root, where they cannot touch the real system.
run_bootstrap() { # <release dir>
  if [[ -n "${HP_BOOTSTRAP_CMD:-}" ]]; then
    "${HP_BOOTSTRAP_CMD}" "$1"
  else
    HP_BOOTSTRAP_QUIET=1 bash "$1/infra/linux/bootstrap-dedicated.sh" "${BOOTSTRAP_ARGS[@]}"
  fi
}
health() {
  if [[ -n "${HP_HEALTH_CMD:-}" ]]; then
    "${HP_HEALTH_CMD}"
  else
    local bind
    bind="$(env_value /etc/hosting-panel/web.env HP_WEB_BIND_ADDRESS)"
    panel_health_check "${bind:-127.0.0.1}" 90
  fi
}
restart_units() { "${SYSTEMCTL}" restart "${UNITS[@]}"; }
restore_prev_units() { # <prev release dir>: put the previous release's units and wrappers back (best effort)
  run_bootstrap "$1" || printf '[WARN] bootstrap of %s failed while restoring it\n' "$1" >&2
  "${SYSTEMCTL}" daemon-reload || true
}

main() {
  set -euo pipefail
  umask 027
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  local version="" archive="" allow_downgrade=0 dry_run=0
  BOOTSTRAP_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version | --archive)
        [[ $# -ge 2 ]] || { usage >&2; die 2 "$1 needs a value"; }
        if [[ "$1" == --version ]]; then version="$2"; else archive="$2"; fi
        shift 2
        ;;
      --allow-downgrade) allow_downgrade=1; shift ;;
      --allow-other-linux) BOOTSTRAP_ARGS+=(--allow-other-linux); shift ;;
      --dry-run) dry_run=1; shift ;;
      --help | -h) usage; exit 0 ;;
      *) usage >&2; die 2 "Unknown argument: $1" ;;
    esac
  done
  [[ -z "${version}" || -z "${archive}" ]] || die 2 "--version and --archive are mutually exclusive"
  [[ -z "${version}" || "${version}" == latest || "${version}" =~ ${_hp_semver_re} ]] || die 2 "Invalid --version: ${version}"
  version="${version:-latest}"
  if [[ -n "${archive}" ]]; then
    [[ "$(basename -- "${archive}")" =~ ^hosting-panel-([0-9]+\.[0-9]+\.[0-9]+)-linux-x64\.tar\.gz$ ]] ||
      die 2 "--archive must be named hosting-panel-<version>-linux-x64.tar.gz"
    version="${BASH_REMATCH[1]}"
    archive="$(cd "$(dirname -- "${archive}")" 2>/dev/null && pwd)/$(basename -- "${archive}")" || die 2 "--archive directory not found"
  fi

  if [[ "${EUID}" -eq 0 ]]; then
    local o
    for o in HP_ROOT HP_SYSTEMCTL HP_HEALTH_CMD HP_BOOTSTRAP_CMD; do
      [[ -z "${!o:-}" ]] || die 2 "${o} is a test override and is refused when running as root"
    done
  elif ((dry_run == 0)) && [[ -z "${HP_ROOT:-}" ]]; then
    die 1 "Run as root (sudo), or pass --dry-run."
  fi
  local root="${HP_ROOT:-${HP_DEFAULT_ROOT}}"
  SYSTEMCTL="${HP_SYSTEMCTL:-systemctl}"
  local prev

  if ((dry_run)); then
    prev="$(current_version "${root}")"
    step 1 "Resolve and fetch the release"
    if [[ -n "${archive}" ]]; then plan "use ${archive}"; else plan "would download release ${version} from github.com/${HP_RELEASE_REPO}"; fi
    step 2 "Verify checksum"
    plan "would verify the archive against its .sha256 (exit 4 on mismatch)"
    step 3 "Version check"
    plan "current: ${prev:-<none>}; same version exits 0, older needs --allow-downgrade"
    step 4 "Install the release"
    plan "would extract into ${root}/releases/${version}"
    step 5 "Bootstrap (units, wrappers, tmpfiles) and daemon-reload"
    plan "would run ${root}/releases/${version}/infra/linux/bootstrap-dedicated.sh ${BOOTSTRAP_ARGS[*]}; systemctl daemon-reload"
    step 6 "Switch current"
    plan "would point ${root}/current at releases/${version}"
    step 7 "Restart services"
    plan "would systemctl restart ${UNITS[*]}"
    step 8 "Health check"
    plan "would wait up to 90 s for http://127.0.0.1:4000/health/ready and http://<HP_WEB_BIND_ADDRESS>:3000/login; on failure roll back to ${prev:-<previous>}"
    step 9 "Prune old releases"
    plan "would keep the 3 newest releases"
    STEP=0
    printf '\nDry run complete: nothing was changed.\n'
    return 0
  fi

  # One update at a time; the lock is released when the process exits.
  exec 9>"${root}/.update.lock"
  flock -n 9 || die 1 "Another update is running (lock ${root}/.update.lock is held)."
  trap on_exit EXIT
  # Read under the lock: a concurrent update could otherwise change it under us.
  prev="$(current_version "${root}")"
  [[ -n "${prev}" ]] || die 1 "No current release under ${root}; run install.sh first."

  step 1 "Resolve and fetch the release"
  if [[ -z "${archive}" ]]; then
    if [[ "${version}" == latest ]]; then
      version="$(latest_release_version)" || die 1 "Could not determine the latest release; pass --version."
      info "Latest release: ${version}"
    fi
    # Fresh 0700 dir: a predictable shared path would let a local user plant an archive root installs.
    DOWNLOAD_DIR="$(mktemp -d)" || die 1 "Cannot create a private download directory."
    archive="$(fetch_release "${version}" "${DOWNLOAD_DIR}")" || die 1 "Download of release ${version} failed."
  fi
  info "archive: ${archive}"

  step 2 "Verify checksum"
  verify_release_archive "${archive}" || die 4 "Release archive checksum verification failed: ${archive}"

  step 3 "Version check"
  if [[ "${version}" == "${prev}" ]]; then
    STEP=0
    printf 'already up to date (%s)\n' "${prev}"
    return 0
  fi
  if version_gt "${prev}" "${version}" && ((allow_downgrade == 0)); then
    die 2 "${version} is older than the current ${prev}; pass --allow-downgrade to install it anyway."
  fi
  info "${prev} -> ${version}"

  step 4 "Install the release"
  # A leftover dir (e.g. from a failed update) is replaced; it is never current here.
  HP_FORCE_REINSTALL=1 install_release "${archive}" "${root}" >/dev/null || die 1 "Could not install release ${version}."

  local new_dir="${root}/releases/${version}" prev_dir="${root}/releases/${prev}"
  step 5 "Bootstrap (units, wrappers, tmpfiles) and daemon-reload"
  if ! run_bootstrap "${new_dir}" || ! "${SYSTEMCTL}" daemon-reload; then
    restore_prev_units "${prev_dir}"
    die 1 "Bootstrap of ${version} failed; services still run ${prev} (not restarted)."
  fi

  step 6 "Switch current"
  if ! swap_current "${root}" "${version}"; then
    restore_prev_units "${prev_dir}"
    die 1 "Could not point current at ${version}; services still run ${prev} (not restarted)."
  fi

  step 7 "Restart services"
  local restarted=1
  restart_units || restarted=0

  step 8 "Health check"
  if ((restarted)) && health; then
    info "API and web console are healthy"
  else
    printf '[ERROR] %s is unhealthy; rolling back to %s\n' "${version}" "${prev}" >&2
    swap_current "${root}" "${prev}" || die 7 "Rollback failed: could not point current back at ${prev} (update to ${version} failed)."
    restore_prev_units "${prev_dir}"
    if restart_units && health; then
      STEP=0
      printf 'rolled back to %s (update to %s failed its health check; %s is kept for inspection)\n' \
        "${prev}" "${version}" "${new_dir}" >&2
      exit 6
    fi
    die 7 "Rollback to ${prev} is unhealthy too (update to ${version} failed). Inspect: journalctl -u hp-api -u hp-web -n 100"
  fi

  step 9 "Prune old releases"
  prune_releases "${root}" 3 || printf '[WARN] pruning old releases failed\n' >&2
  STEP=0
  printf '\nupdated %s → %s\n' "${prev}" "${version}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
