#!/usr/bin/env bash
# ==============================================================================
# Hosting Panel — fresh-server installer (Ubuntu 24.04/26.04, Debian 12/13, x86_64).
# Every step is idempotent: rerunning on an installed server never regenerates keys,
# secrets or the DB password and never recreates the administrator.
# ==============================================================================

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh --hostname <fqdn> --admin-email <email> --admin-name "<name>"
                            [--acme-email <email>] [--ipv4 <addr>]
                            [--version <v> | --archive <path>] [--acme-staging]
                            [--skip-firewall] [--dry-run] [--allow-other-linux]

  --acme-email   Let's Encrypt account email (default: --admin-email).
  --ipv4         Public IPv4 of this server (default: source address of the default route).
  --version      Release to install (default: latest GitHub release).
  --archive      Local hosting-panel-<v>-linux-x64.tar.gz (its .sha256 must sit next to it).
  --skip-firewall  Do not install the panel nftables ruleset (you manage the firewall yourself).
  --dry-run      Print the plan; changes nothing, needs neither root nor network.

The admin password is prompted (hidden, twice, >= 12 chars). For automation only, HP_ADMIN_PASSWORD
is read instead; never put it on a command line (shell history, ps).

Exit codes: 0 ok, 1 step failed, 2 bad arguments (or archive VERSION differs from its file
name), 3 unsupported OS/architecture or no
docker-ce/postgresql-18 for this release, 4 checksum failure, 5 health check timeout,
6 docker0 has no IPv4, 7 SSH is not on port 22 (use --skip-firewall).
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/os.sh
. "${SCRIPT_DIR}/lib/os.sh"
# shellcheck source=lib/release.sh
. "${SCRIPT_DIR}/lib/release.sh"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

STATE_DIR="${HP_INSTALL_STATE_DIR:-/etc/hosting-panel}"
ROOT="/opt/hosting-panel"
STEP=0
STEP_NAME=""
TOTAL=12

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

# Rewrites KEY=VALUE lines in an env file atomically (0400 root:root); other lines are kept
# byte for byte, missing keys are appended. Values are never printed.
set_env_keys() {
  local file="$1" kv line key tmp
  shift
  local -A want=() seen=()
  for kv in "$@"; do want["${kv%%=*}"]="${kv#*=}"; done
  tmp="$(mktemp "$(dirname -- "${file}")/.env.XXXXXX")" || return 1
  {
    while IFS= read -r line || [[ -n "${line}" ]]; do
      key="${line%%=*}"
      # ${arr[$k]+x}, not -v: -v re-expands the subscript.
      if [[ "${line}" == *=* && -n "${key}" && -n "${want[${key}]+x}" ]]; then
        printf '%s=%s\n' "${key}" "${want[${key}]}"
        seen["${key}"]=1
      else
        printf '%s\n' "${line}"
      fi
    done <"${file}"
    for kv in "$@"; do # argument order, so appended lines are deterministic
      key="${kv%%=*}"
      [[ -n "${seen[${key}]+x}" ]] || printf '%s=%s\n' "${key}" "${want[${key}]}"
    done
  } >"${tmp}" || { rm -f -- "${tmp}"; return 1; }
  if ! install -m 0400 -o root -g root "${tmp}" "${file}.new" || ! mv -f -- "${file}.new" "${file}"; then
    rm -f -- "${tmp}" "${file}.new"
    return 1
  fi
  rm -f -- "${tmp}"
}

pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }

docker0_ipv4() { { ip -4 -o addr show docker0 2>/dev/null || true; } | awk '{split($4, a, "/"); print a[1]; exit}'; }

# Prints the docker0 IPv4 the web console binds to; exit 6 rather than binding to all interfaces.
panel_bind_address() {
  local b
  b="$(docker0_ipv4)"
  [[ -n "${b}" ]] || die 6 "docker0 has no IPv4 address; is Docker running with its default bridge? (refusing to bind the web console to all interfaces)"
  printf '%s\n' "${b}"
}

# Ports SSH listens on, one per line (empty if unknown), from `sshd -T` output ($1) and
# `ss -ltnpH` output ($2). ListenAddress lines carry the port actually bound ([v6]:port too) and
# override Port lines; ss adds live sshd listeners and systemd ones (socket-activated ssh.socket).
sshd_ports_from() { # <sshd -T output> <ss -ltnpH output>
  local cfg
  cfg="$(awk '$1 == "listenaddress" {n = split($2, a, ":"); print a[n]}' <<<"$1")"
  [[ -n "${cfg}" ]] || cfg="$(awk '$1 == "port" {print $2}' <<<"$1")"
  {
    printf '%s\n' "${cfg}"
    awk '/"(sshd|systemd)"/ {n = split($4, a, ":"); print a[n]}' <<<"$2"
  } | { grep -E '^[0-9]+$' || true; } | sort -un
}

sshd_ports() { sshd_ports_from "$(sshd -T 2>/dev/null || true)" "$(ss -ltnpH 2>/dev/null || true)"; }

# Adds an apt repo and checks the package has a candidate; on any failure removes what it added
# (a broken .list would break every later apt run) and exits 3.
add_apt_repo() { # <keyring name> <key url> <list name> <repo line> <package> <message>
  local key="/etc/apt/keyrings/$1.asc" list="/etc/apt/sources.list.d/$3.list" new_key=0 candidate=""
  [[ -e "${key}" ]] || new_key=1
  if ! curl -fsSL --retry 3 --connect-timeout 15 "$2" -o "${key}"; then
    ((new_key == 0)) || rm -f -- "${key}"
    die 1 "Cannot download the $1 apt key from $2"
  fi
  chmod 0644 "${key}"
  printf '%s\n' "$4" >"${list}"
  chmod 0644 "${list}"
  if apt-get update -q; then
    candidate="$(apt-cache policy "$5" | awk '/Candidate:/ {print $2}')"
  fi
  if [[ -z "${candidate}" || "${candidate}" == "(none)" ]]; then
    rm -f -- "${list}"
    ((new_key == 0)) || rm -f -- "${key}"
    apt-get update -q >/dev/null 2>&1 || true
    die 3 "$6"
  fi
}

DOWNLOAD_DIR=""

on_exit() {
  local rc=$?
  [[ -z "${DOWNLOAD_DIR}" ]] || rm -rf -- "${DOWNLOAD_DIR}"
  if ((rc != 0 && STEP > 0)); then
    printf '\n[ERROR] Step %s/%s (%s) failed with exit code %s.\n' "${STEP}" "${TOTAL}" "${STEP_NAME}" "${rc}" >&2
    printf '[ERROR] Fix the cause above, then rerun (it is safe to rerun):\n  sudo bash %q' "${SCRIPT_DIR}/install.sh" >&2
    printf ' %q' "${ORIG_ARGS[@]}" >&2
    printf '\n' >&2
  fi
}

main() {
  set -euo pipefail
  umask 027
  ORIG_ARGS=("$@")

  local hostname="" admin_email="" admin_name="" acme_email="" ipv4="" version="" archive=""
  local acme_staging=false dry_run=0 allow_other=0 skip_firewall=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --hostname | --admin-email | --admin-name | --acme-email | --ipv4 | --version | --archive)
        [[ $# -ge 2 ]] || { usage >&2; die 2 "$1 needs a value"; }
        case "$1" in
          --hostname) hostname="${2,,}" ;;
          --admin-email) admin_email="$2" ;;
          --admin-name) admin_name="$2" ;;
          --acme-email) acme_email="$2" ;;
          --ipv4) ipv4="$2" ;;
          --version) version="$2" ;;
          --archive) archive="$2" ;;
        esac
        shift 2
        ;;
      --acme-staging) acme_staging=true; shift ;;
      --dry-run) dry_run=1; shift ;;
      --skip-firewall) skip_firewall=1; shift ;;
      --allow-other-linux) allow_other=1; shift ;;
      --help | -h) usage; exit 0 ;;
      *) usage >&2; die 2 "Unknown argument: $1" ;;
    esac
  done

  # Validation at the trust boundary: these values end up in env files and DB rows.
  local fqdn_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  local email_re='^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  local ipv4_re='^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$'
  [[ -n "${hostname}" ]] || { usage >&2; die 2 "--hostname is required"; }
  [[ "${hostname}" =~ ${fqdn_re} ]] || die 2 "Invalid --hostname: ${hostname}"
  [[ "${admin_email}" =~ ${email_re} ]] || die 2 "Missing or invalid --admin-email"
  [[ -n "${admin_name}" && "${admin_name}" != *$'\n'* ]] || die 2 "Missing or invalid --admin-name"
  acme_email="${acme_email:-${admin_email}}"
  [[ "${acme_email}" =~ ${email_re} ]] || die 2 "Invalid --acme-email"
  [[ -z "${ipv4}" || "${ipv4}" =~ ${ipv4_re} ]] || die 2 "Invalid --ipv4: ${ipv4}"
  [[ -z "${version}" || -z "${archive}" ]] || die 2 "--version and --archive are mutually exclusive"
  [[ -z "${version}" || "${version}" == latest || "${version}" =~ ${_hp_semver_re} ]] || die 2 "Invalid --version: ${version}"
  version="${version:-latest}"
  if [[ -n "${archive}" ]]; then
    [[ "$(basename -- "${archive}")" =~ ^hosting-panel-([0-9]+\.[0-9]+\.[0-9]+)-linux-x64\.tar\.gz$ ]] ||
      die 2 "--archive must be named hosting-panel-<version>-linux-x64.tar.gz"
    version="${BASH_REMATCH[1]}"
    archive="$(cd "$(dirname -- "${archive}")" 2>/dev/null && pwd)/$(basename -- "${archive}")" || die 2 "--archive directory not found"
  fi

  local admin_done=0 admin_password="${HP_ADMIN_PASSWORD:-}"
  unset HP_ADMIN_PASSWORD # keep it out of every child's environment; only hp-accounts gets it
  [[ -e "${STATE_DIR}/admin-created" ]] && admin_done=1
  if [[ -n "${admin_password}" && ${#admin_password} -lt 12 ]]; then
    die 2 "HP_ADMIN_PASSWORD must be at least 12 characters"
  fi

  if ((dry_run == 0)); then
    [[ "${EUID}" -eq 0 ]] || die 1 "Run as root (sudo), or pass --dry-run."
    [[ "${STATE_DIR}" == /etc/hosting-panel ]] || die 2 "HP_INSTALL_STATE_DIR is only for --dry-run tests"
    if ((admin_done == 0)) && [[ -z "${admin_password}" ]]; then
      local again
      read -rsp "Password for the first administrator (min 12 chars): " admin_password </dev/tty ||
        die 2 "No terminal for the password prompt: set HP_ADMIN_PASSWORD"
      echo
      read -rsp "Repeat the password: " again </dev/tty; echo
      [[ "${admin_password}" == "${again}" ]] || die 2 "Passwords do not match"
      [[ ${#admin_password} -ge 12 ]] || die 2 "Password must be at least 12 characters"
    fi
  fi
  trap on_exit EXIT
  export DEBIAN_FRONTEND=noninteractive

  # ---------------------------------------------------------------- 1
  step 1 "Operating system check"
  local os os_id codename
  export HP_ALLOW_OTHER_LINUX="${allow_other}"
  os="$(detect_supported_os)" || die 3 "Unsupported operating system."
  read -r os_id codename <<<"${os}"
  ((dry_run)) || [[ "$(uname -m)" == x86_64 ]] || die 3 "Only x86_64 is supported (release archives are linux-x64)."
  info "Detected ${os_id} ${codename}"
  # SSH preflight (R9), done here so a lockout risk stops the install before anything changes.
  if ((skip_firewall)); then
    info "--skip-firewall: the panel firewall will not be installed"
  else
    local ports
    if ((dry_run)) && [[ -n "${HP_SSHD_T_OUTPUT+x}" ]]; then
      ports="$(sshd_ports_from "${HP_SSHD_T_OUTPUT}" "${HP_SS_OUTPUT:-}")" # raw outputs, test override
    elif ((dry_run)) && [[ -n "${HP_SSHD_PORTS+x}" ]]; then
      ports="$(tr ' ' '\n' <<<"${HP_SSHD_PORTS}" | grep . || true)"
    else
      ports="$(sshd_ports)"
    fi
    if [[ -z "${ports}" ]]; then
      if ((dry_run)); then
        info "SSH ports unknown (sshd -T needs root); the live run checks them"
      else
        die 7 "Cannot detect which port SSH listens on; the panel firewall only allows 22/80/443. Rerun with --skip-firewall and manage the firewall yourself."
      fi
    elif ! grep -qx 22 <<<"${ports}"; then
      die 7 "SSH listens on port $(paste -sd, <<<"${ports}"); the panel firewall only allows 22/80/443. Move SSH to 22 or rerun with --skip-firewall and manage the firewall yourself."
    else
      info "SSH listens on port 22"
    fi
  fi
  # The release is obtained and verified here, before any package is installed or changed.
  # Fresh 0700 dir: a predictable shared path would let a local user plant an archive root installs.
  if [[ -n "${archive}" ]] || ((dry_run == 0)); then
    DOWNLOAD_DIR="$(mktemp -d)" || die 1 "Cannot create a private download directory."
  fi
  if [[ -n "${archive}" ]]; then
    # Only the private copy is read from now on: the original could be swapped after the check.
    archive="$(stage_release_archive "${archive}" "${DOWNLOAD_DIR}")" || die 1 "Cannot copy --archive into ${DOWNLOAD_DIR}."
  elif ((dry_run)); then
    plan "would download release ${version} from github.com/${HP_RELEASE_REPO} and verify its .sha256"
  else
    command -v curl >/dev/null || die 1 "curl is required to download the release; install it or pass --archive."
    if [[ "${version}" == latest ]]; then
      version="$(latest_release_version)" || die 1 "Could not determine the latest release; pass --version."
      ORIG_ARGS+=(--version "${version}") # a rerun installs the same version
      info "Latest release: ${version}"
    fi
    archive="$(fetch_release "${version}" "${DOWNLOAD_DIR}")" || die 1 "Download of release ${version} failed."
  fi
  if [[ -n "${archive}" ]]; then
    verify_release_archive "${archive}" || die 4 "Release archive checksum verification failed: ${archive}"
    archive_has_version "${archive}" "${version}" ||
      die 2 "The archive does not contain hosting-panel-${version}/VERSION = ${version}; refusing a mislabelled archive."
    info "Release ${version} verified (${archive})"
  fi

  # ---------------------------------------------------------------- 2
  step 2 "apt prerequisites"
  # libatomic1: the official Node 26 linux-x64 binary links against it; minimal images lack it.
  local prereqs=(curl ca-certificates gnupg nftables openssl tar xz-utils iproute2 libatomic1)
  if ((dry_run)); then
    plan "apt-get install -y ${prereqs[*]}"
  else
    apt-get update -q
    apt-get install -y -q --no-install-recommends "${prereqs[@]}"
    install -d -m 0755 /etc/apt/keyrings
  fi
  if [[ -z "${ipv4}" ]]; then
    ipv4="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')" || ipv4=""
    if [[ -z "${ipv4}" ]]; then
      ((dry_run)) && ipv4="<default-route-ipv4>" || die 2 "Cannot detect the server IPv4; pass --ipv4."
    fi
  fi
  info "Panel IPv4: ${ipv4}"

  # ---------------------------------------------------------------- 3
  step 3 "Docker CE"
  local docker_repo="deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${os_id} ${codename} stable"
  info "repo: ${docker_repo}"
  if ((dry_run)); then
    if pkg_installed docker-ce; then plan "skip: docker-ce already installed"; else plan "would add the repo above and install docker-ce (removing docker.io/podman-docker/containerd/runc if present)"; fi
    plan "systemctl enable --now docker"
  else
    if ! pkg_installed docker-ce; then
      local p remove=()
      for p in docker.io docker-compose docker-doc podman-docker containerd runc; do
        pkg_installed "${p}" && remove+=("${p}")
      done
      ((${#remove[@]} == 0)) || apt-get remove -y -q "${remove[@]}"
      add_apt_repo docker "https://download.docker.com/linux/${os_id}/gpg" docker "${docker_repo}" docker-ce \
        "Docker's apt repository has no docker-ce package for ${os_id} ${codename} (yet). See https://docs.docker.com/engine/install/ — the installer never falls back to the distro docker.io package."
      apt-get install -y -q docker-ce docker-ce-cli containerd.io
    else
      info "docker-ce already installed"
    fi
    systemctl enable --now docker
  fi

  # ---------------------------------------------------------------- 4
  step 4 "Node.js (exact version from the release)"
  # RELEASE.json (in the archive verified in step 1) names the Node version.
  local node_version="<RELEASE.json node>"
  if ((dry_run)); then
    plan "would install Node ${node_version} from https://nodejs.org/dist/v<v>/node-v<v>-linux-x64.tar.xz (verified against SHASUMS256.txt) into /opt/node-v<v>, symlink /usr/bin/node (skip if node --version matches)"
  else
    node_version="$(tar -xzOf "${archive}" "hosting-panel-${version}/RELEASE.json" |
      sed -n 's/.*"node": *"\([0-9.]*\)".*/\1/p' | head -n1)" || node_version=""
    [[ "${node_version}" =~ ${_hp_semver_re} ]] || die 1 "RELEASE.json has no valid node version"
    if [[ "$(/usr/bin/node --version 2>/dev/null || true)" == "v${node_version}" ]]; then
      info "Node v${node_version} already installed"
    else
      local nd tarball="node-v${node_version}-linux-x64.tar.xz"
      nd="$(mktemp -d)"
      curl -fsSL --retry 3 --connect-timeout 15 -o "${nd}/${tarball}" "https://nodejs.org/dist/v${node_version}/${tarball}"
      curl -fsSL --retry 3 --connect-timeout 15 -o "${nd}/SHASUMS256.txt" "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
      if ! (cd "${nd}" && grep "  ${tarball}\$" SHASUMS256.txt | sha256sum -c --status); then
        rm -rf -- "${nd}"
        die 4 "Node tarball checksum mismatch (${tarball})"
      fi
      rm -rf -- "/opt/node-v${node_version}.tmp"
      mkdir -p "/opt/node-v${node_version}.tmp"
      tar -xJf "${nd}/${tarball}" --strip-components=1 --no-same-owner -C "/opt/node-v${node_version}.tmp"
      rm -rf -- "/opt/node-v${node_version}" "${nd}"
      mv -T "/opt/node-v${node_version}.tmp" "/opt/node-v${node_version}"
      chmod -R go+rX "/opt/node-v${node_version}"
      ln -sfn "/opt/node-v${node_version}/bin/node" /usr/bin/node
      info "Installed Node v${node_version}"
    fi
    # Fail here, not at step 11, if the binary cannot run (e.g. a missing shared library).
    local node_ran
    node_ran="$(/usr/bin/node --version 2>&1)" || node_ran="${node_ran:-exit $?}"
    [[ "${node_ran}" == "v${node_version}" ]] ||
      die 1 "/usr/bin/node does not run as v${node_version}: ${node_ran}"
  fi

  # ---------------------------------------------------------------- 5
  step 5 "PostgreSQL 18 (PGDG)"
  local pg_repo="deb [signed-by=/etc/apt/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main"
  info "repo: ${pg_repo}"
  if ((dry_run)); then
    plan "would pin o=apt.postgresql.org (priority 600) in /etc/apt/preferences.d/pgdg.pref"
    plan "would install postgresql-18 if missing; systemctl enable --now postgresql"
  else
    printf 'Package: *\nPin: release o=apt.postgresql.org\nPin-Priority: 600\n' >/etc/apt/preferences.d/pgdg.pref
    chmod 0644 /etc/apt/preferences.d/pgdg.pref
    if ! pkg_installed postgresql-18; then
      add_apt_repo postgresql https://www.postgresql.org/media/keys/ACCC4CF8.asc pgdg "${pg_repo}" postgresql-18 \
        "The PGDG apt repository has no postgresql-18 package for ${os_id} ${codename}. See https://www.postgresql.org/download/linux/"
      apt-get install -y -q postgresql-18
    else
      info "postgresql-18 already installed"
    fi
    systemctl enable --now postgresql
  fi

  # ---------------------------------------------------------------- 6
  step 6 "Install the release"
  if ((dry_run)); then
    plan "would install the verified archive into ${ROOT}/releases/<version> and point ${ROOT}/current at it"
  else
    if [[ -d "${ROOT}/releases/${version}" ]]; then
      info "release ${version} already present"
    else
      install_release "${archive}" "${ROOT}" >/dev/null
    fi
    swap_current "${ROOT}" "${version}"
    info "current -> releases/${version}"
  fi

  # ---------------------------------------------------------------- 7
  step 7 "Bootstrap users, keys, directories and systemd units"
  local k keys_present=1
  for k in ipc.key secrets-master.key breakglass-jwt.key jwt-signing.pem; do
    [[ -s "${STATE_DIR}/${k}" ]] || keys_present=0
  done
  local bootstrap_args=()
  ((allow_other)) && bootstrap_args+=(--allow-other-linux)
  if ((dry_run)); then
    if ((keys_present)); then plan "skip key generation: keys already present in ${STATE_DIR}"; else plan "would generate keys in ${STATE_DIR} (ipc, secrets-master, breakglass-jwt, jwt-signing)"; fi
    plan "would run ${ROOT}/current/infra/linux/bootstrap-dedicated.sh (users, dirs, env files only if absent, units, wrappers)"
  else
    bash "${ROOT}/current/infra/linux/bootstrap-dedicated.sh" "${bootstrap_args[@]}"
  fi

  # ---------------------------------------------------------------- 8
  step 8 "Database role and database"
  local api_env="${STATE_DIR}/api.env"
  if ((dry_run)); then
    if [[ -n "$(env_value "${api_env}" DATABASE_URL)" ]]; then
      plan "skip: role hosting_panel already provisioned (DATABASE_URL is set in api.env)"
    else
      plan "would create role and database hosting_panel with a random password and write DATABASE_URL to api.env (value not shown)"
    fi
  else
    local i role_exists
    for i in $(seq 30); do
      (cd / && runuser -u postgres -- psql -X -qtAc 'select 1' >/dev/null 2>&1) && break
      ((i < 30)) || die 1 "PostgreSQL is not accepting connections"
      sleep 1
    done
    local pg_port
    pg_port="$(pg_lsclusters -h 2>/dev/null | awk '$1 == "18" {print $3; exit}')" || pg_port=""
    [[ "${pg_port}" == 5432 ]] ||
      die 1 "The PostgreSQL 18 cluster listens on port '${pg_port:-none}', not 5432 (another PostgreSQL owns 5432?). Fix it (pg_lsclusters) and rerun."
    role_exists="$(cd / && runuser -u postgres -- psql -X -qtAc "select 1 from pg_roles where rolname = 'hosting_panel'")"
    if [[ -n "$(env_value "${api_env}" DATABASE_URL)" && "${role_exists}" == 1 ]]; then
      info "skip: role hosting_panel already provisioned"
    else
      local pw
      pw="$(openssl rand -hex 32)"
      # The password reaches psql through stdin (\set), never argv; :'pw' quotes it as a literal.
      {
        printf '\\set pw %s\n' "${pw}"
        cat <<'SQL'
SELECT 'CREATE ROLE hosting_panel LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hosting_panel') \gexec
ALTER ROLE hosting_panel LOGIN PASSWORD :'pw';
SELECT 'CREATE DATABASE hosting_panel OWNER hosting_panel' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hosting_panel') \gexec
SQL
      } | (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres >/dev/null)
      # PGDG's default pg_hba allows scram-sha-256 password logins on 127.0.0.1.
      set_env_keys "${api_env}" "DATABASE_URL=postgresql://hosting_panel:${pw}@127.0.0.1:5432/hosting_panel"
      unset pw
      info "Created role/database hosting_panel and wrote DATABASE_URL to api.env"
    fi
  fi

  # ---------------------------------------------------------------- 9
  step 9 "Panel settings in web.env and executor.env"
  local bind
  if ((dry_run)); then
    if [[ -n "${HP_DOCKER0_IPV4+x}" ]]; then bind="${HP_DOCKER0_IPV4}"; else bind="$(docker0_ipv4)"; fi
    plan "would set web.env HP_WEB_BIND_ADDRESS=${bind:-<docker0 IPv4>}"
    plan "would set executor.env HP_PANEL_HOSTNAME=${hostname} HP_PANEL_IPV4=${ipv4} HP_ACME_EMAIL=${acme_email} HP_ACME_STAGING=${acme_staging}"
  else
    bind="$(panel_bind_address)"
    set_env_keys "${STATE_DIR}/web.env" "HP_WEB_BIND_ADDRESS=${bind}"
    set_env_keys "${STATE_DIR}/executor.env" "HP_PANEL_HOSTNAME=${hostname}" "HP_PANEL_IPV4=${ipv4}" \
      "HP_ACME_EMAIL=${acme_email}" "HP_ACME_STAGING=${acme_staging}"
    info "web console binds to ${bind}:3000"
  fi

  # ---------------------------------------------------------------- 10
  step 10 "Firewall (nftables)"
  local nft_src="${ROOT}/current/infra/linux/nftables-dedicated.conf" nft_dst=/etc/nftables.d/hosting-panel.nft
  local include_line="include \"${nft_dst}\""
  if ((skip_firewall)); then
    info "skip: --skip-firewall given; manage the firewall yourself (allow 22/80/443, and 3000 from docker bridges only)"
  elif ((dry_run)); then
    plan "would apply nft -f ${nft_src}, install it as ${nft_dst}, add '${include_line}' to /etc/nftables.conf if missing, enable nftables.service"
  else
    # Our file deletes/recreates only table inet hp_dedicated_filter; we never flush the ruleset
    # (that would drop Docker's iptables-nft NAT/filter tables, which Docker recreates only on restart).
    nft -f "${nft_src}"
    install -d -m 0755 /etc/nftables.d
    install -m 0644 -o root -g root "${nft_src}" "${nft_dst}"
    [[ -e /etc/nftables.conf ]] || printf '#!/usr/sbin/nft -f\n' >/etc/nftables.conf
    grep -qxF "${include_line}" /etc/nftables.conf || printf '%s\n' "${include_line}" >>/etc/nftables.conf
    # Enable for boot only, never start/restart now: the distro nftables.conf starts with
    # "flush ruleset", which at boot runs before Docker, but now would wipe Docker's live tables.
    systemctl enable nftables
  fi

  # ---------------------------------------------------------------- 11
  step 11 "First administrator"
  local totp_secret="" totp_uri=""
  if ((dry_run)); then
    if ((admin_done)); then
      plan "skip: administrator already created (${STATE_DIR}/admin-created)"
    else
      plan "would run hp-accounts setup --name ${hostname} --hostname ${hostname} --ipv4 ${ipv4}"
      plan "would create the first administrator ${admin_email} (password via env, not shown) and print the TOTP enrolment once"
    fi
  else
    if ((admin_done == 0)); then
      local has_admin
      has_admin="$(cd / && runuser -u postgres -- psql -X -qtA -d hosting_panel \
        -c "select 1 from users where platform_role = 'infrastructure_admin' limit 1" 2>/dev/null || true)"
      [[ "${has_admin}" == 1 ]] && admin_done=1
    fi
    if ((admin_done)); then
      info "skip: administrator already created"
    else
      /usr/local/sbin/hp-accounts setup --name "${hostname}" --hostname "${hostname}" --ipv4 "${ipv4}" >/dev/null
      local out
      out="$(HP_NEW_PASSWORD="${admin_password}" /usr/local/sbin/hp-accounts create-admin --email "${admin_email}" --name "${admin_name}")"
      totp_secret="$(sed -n 's/.*"totpSecretBase32":"\([^"]*\)".*/\1/p' <<<"${out}")"
      totp_uri="$(sed -n 's/.*"otpauthUri":"\([^"]*\)".*/\1/p' <<<"${out}")"
      unset out
      [[ -n "${totp_secret}" ]] ||
        die 1 "hp-accounts create-admin returned no TOTP secret for ${admin_email}; the administrator may not exist. Check with: sudo hp-accounts reset-totp --email ${admin_email} (it fails if there is no such user), then rerun."
      info "Created administrator ${admin_email}"
      # Printed now, not only in the summary: if a later step fails the secret would be lost.
      cat <<EOF

  ************************************************************************
   Two-factor enrolment for ${admin_email} (shown ONCE, add it now):
     secret: ${totp_secret}
     URI:    ${totp_uri}
  ************************************************************************
EOF
    fi
    install -m 0400 -o root -g root /dev/null "${STATE_DIR}/admin-created"
  fi
  unset admin_password

  # ---------------------------------------------------------------- 12
  step 12 "Start services and wait for health"
  local units=(hp-host-agent hp-docker-executor hp-api hp-web)
  if ((dry_run)); then
    plan "would systemctl enable + restart ${units[*]}"
    plan "would wait up to 90 s for http://127.0.0.1:4000/health/ready and http://<docker0 IPv4>:3000/login"
  else
    systemctl enable "${units[@]}"
    # restart (not just --now) so a rerun picks up the new release and env values.
    systemctl restart "${units[@]}"
    panel_health_check "${bind}" 90 || die 5 "Health check failed (timeout 90 s). Inspect: journalctl -u hp-host-agent -u hp-docker-executor -u hp-api -u hp-web -n 100"
    info "API, web console, host agent and executor are healthy"
  fi

  STEP=0
  if ((dry_run)); then
    printf '\nDry run complete: nothing was changed.\n'
    return 0
  fi
  cat <<EOF

==============================================================================
 Hosting Panel is installed.

 Panel:  https://${hostname}
         https://${ipv4}   (self-signed certificate until DNS points here)

 DNS:    create an A record   ${hostname}.  A  ${ipv4}
         The Let's Encrypt certificate is obtained automatically once it resolves.
EOF
  if [[ -n "${totp_secret}" ]]; then
    cat <<EOF

 Reminder: two-factor enrolment for ${admin_email} (also printed in step 11):
   secret: ${totp_secret}
   URI:    ${totp_uri}
EOF
  fi
  if ((skip_firewall)); then
    cat <<'EOF'

 !!! WARNING: --skip-firewall was given. The panel firewall is NOT installed.
 !!! Allow only TCP 22 (or your SSH port), 80 and 443 inbound, and port 3000
 !!! only from Docker bridges, or the web console's internal port may be exposed.
EOF
  fi
  cat <<'EOF'
==============================================================================

##############################################################################
#  !!! IT: Fai SUBITO un backup di /etc/hosting-panel (chiavi) — senza di    #
#      esse i dati cifrati e i backup non sono recuperabili.                 #
#  !!! EN: Back up /etc/hosting-panel (keys) now — without them encrypted    #
#      data and backups cannot be recovered.                                 #
##############################################################################
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
