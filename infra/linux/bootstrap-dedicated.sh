#!/usr/bin/env bash
# ==============================================================================
# HCP-SPEC-003 §9.1 — Idempotent Dedicated Host Bootstrap Script
# Target: Ubuntu 24.04/26.04, Debian 12/13 (kernel 6.x+, cgroups v2, Docker Engine)
# ==============================================================================
set -euo pipefail
umask 027

DRY_RUN=0
ALLOW_OTHER_LINUX=0

usage() {
  cat <<'EOF'
Usage: bootstrap-dedicated.sh [--dry-run] [--allow-other-linux] [--help]

Options:
  --dry-run            Validate host prerequisites and print planned idempotent
                       actions without requiring root or modifying the system.
  --allow-other-linux  Allow non-Ubuntu-24.04 / non-Debian-12 Linux distributions
                       (for CI/lab Linux hosts) while enforcing kernel 6.x+ and cgroups v2.
  --help               Show this help message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --allow-other-linux)
      ALLOW_OTHER_LINUX=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SYSTEMD_SRC_DIR="${REPO_ROOT}/infra/systemd"
NFTABLES_SRC_FILE="${SCRIPT_DIR}/nftables-dedicated.conf"

log_info() {
  printf '[INFO] %s\n' "$*"
}

log_dry() {
  printf '[DRY-RUN] %s\n' "$*"
}

fail() {
  printf '[ERROR] %s\n' "$*" >&2
  exit 1
}

# 1. Verify Linux OS & supported distribution
if [[ "$(uname -s)" != "Linux" ]]; then
  fail "Dedicated bootstrap requires a Linux host (detected: $(uname -s))."
fi

# shellcheck source=lib/os.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/os.sh"
export HP_ALLOW_OTHER_LINUX="${ALLOW_OTHER_LINUX}"
OS_DETECTED="$(detect_supported_os)" || fail "Unsupported distribution. Supported: ${HP_SUPPORTED_OS} (use --allow-other-linux for lab hosts)."
log_info "Verified OS: ${OS_DETECTED}"

# 2. Verify Linux kernel 6.x+
KERNEL_RELEASE="$(uname -r)"
KERNEL_MAJOR="${KERNEL_RELEASE%%.*}"
if [[ ! "${KERNEL_MAJOR}" =~ ^[0-9]+$ ]] || (( KERNEL_MAJOR < 6 )); then
  fail "Linux kernel 6.x+ is required (detected: ${KERNEL_RELEASE})."
fi
log_info "Verified Linux kernel release: ${KERNEL_RELEASE} (major=${KERNEL_MAJOR})"

# 3. Verify cgroups v2 unified hierarchy
if [[ ! -e /sys/fs/cgroup/cgroup.controllers ]]; then
  fail "cgroups v2 unified hierarchy is required (/sys/fs/cgroup/cgroup.controllers missing)."
fi
log_info "Verified cgroups v2 unified hierarchy (/sys/fs/cgroup/cgroup.controllers)"

# 4. Verify Docker Engine availability
if command -v docker >/dev/null 2>&1; then
  log_info "Verified Docker CLI binary: $(command -v docker)"
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    if [[ ! -S /var/run/docker.sock ]]; then
      fail "Docker Engine socket /var/run/docker.sock is not present or active."
    fi
  fi
else
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log_dry "Docker CLI not found in PATH; skipping live daemon check in --dry-run mode"
  else
    fail "Docker Engine is required but 'docker' binary was not found in PATH."
  fi
fi

# 5. Verify required repository artifacts before touching host state
REQUIRED_UNITS=(
  "hp-web.service"
  "hp-api.service"
  "hp-docker-executor.service"
  "hp-host-agent.service"
  "hp-unit-restart@.path"
  "hp-unit-restart@.service"
  "hp-panel-update.path"
  "hp-panel-update.service"
  "hp-os-refresh.path"
  "hp-os-refresh.service"
  "hp-os-upgrade.path"
  "hp-os-upgrade.service"
)

for unit_name in "${REQUIRED_UNITS[@]}"; do
  if [[ ! -r "${SYSTEMD_SRC_DIR}/${unit_name}" ]]; then
    fail "Required systemd unit missing or unreadable: ${SYSTEMD_SRC_DIR}/${unit_name}"
  fi
done

if [[ ! -r "${NFTABLES_SRC_FILE}" ]]; then
  fail "Required static nftables ruleset missing: ${NFTABLES_SRC_FILE}"
fi
log_info "Verified systemd unit templates and static nftables baseline ruleset"

# Resolve nologin shell path
NOLOGIN_SHELL="/usr/sbin/nologin"
if [[ ! -x "${NOLOGIN_SHELL}" && -x "/sbin/nologin" ]]; then
  NOLOGIN_SHELL="/sbin/nologin"
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  log_dry "Would install with apt-get, before anything else, those of these OS packages that are missing: ${HP_OS_PACKAGES[*]}"
  log_dry "Would ensure system group: hp-ipc"
  log_dry "Would ensure system users (${NOLOGIN_SHELL}): hp-web, hp-api (hp-ipc), hp-executor (docker,hp-ipc), hp-agent (hp-ipc), hp-mariadb (no supplementary groups)"
  log_dry "Would ensure directory /etc/hosting-panel (0750 root:hp-ipc)"
  log_dry "Would install /etc/hosting-panel/nftables-dedicated.conf (0640 root:hp-ipc)"
  log_dry "Would refresh /etc/nftables.d/hosting-panel.nft (0644 root:root) only if it exists"
  log_dry "Would idempotently provision 32-byte key /etc/hosting-panel/ipc.key (0440 root:hp-ipc)"
  log_dry "Would idempotently provision 32-byte key /etc/hosting-panel/secrets-master.key (0400 hp-api:root)"
  log_dry "Would idempotently provision 32-byte key /etc/hosting-panel/breakglass-jwt.key (0400 hp-api:root)"
  log_dry "Would idempotently generate RSA-3072 JWT signing key /etc/hosting-panel/jwt-signing.pem (0400 hp-api:root)"
  log_dry "Would idempotently provision 32-byte key /etc/hosting-panel/mariadb-root.key (0440 hp-mariadb:hp-executor)"
  log_dry "Would idempotently provision 32-byte key /etc/hosting-panel/backup.key (0440 root:hp-executor)"
  log_dry "Would create (only if absent) /etc/hosting-panel/api.env, web.env (BFF_SESSION_SECRET=<64 hex>) and executor.env, each 0400 root:root"
  log_dry "Would install /usr/local/sbin/hp-accounts, /usr/local/sbin/hp-break-glass, /usr/local/sbin/hp-update and /usr/local/sbin/hp-restore-panel (0750 root:root)"
  log_dry "Would ensure directories /var/lib/hosting-panel/{ingress/static,ingress/dynamic,sites} (0750) and ingress/acme (0700 hp-executor), ingress/dynamic/manual-certs (0700 hp-executor:hp-executor), mariadb (0750 hp-executor:hp-ipc) and /var/lib/hosting-panel/mariadb/data (0700 hp-mariadb), /var/lib/hosting-panel/site-mail (0755 hp-executor:hp-executor), /var/lib/hosting-panel/sftp (0700 hp-executor:hp-executor), /var/lib/hosting-panel/phpmyadmin (0755 hp-executor:hp-executor), and /var/lib/hosting-panel/backups (0700 hp-executor:hp-executor), /var/lib/hosting-panel/local-repos (2770 hp-executor:hp-executor, HP_BACKUP_LOCAL_ROOT), and /var/lib/hosting-panel/panel-dump (2770 root:hp-ipc)"
  log_dry "Would install /etc/tmpfiles.d/hosting-panel.conf and ensure /run/hosting-panel (3770 root:hp-ipc) + /run/hosting-panel/secrets (0700 hp-executor:hp-executor) + /run/hosting-panel/mail-relay (0755 hp-executor:hp-executor) + /run/hosting-panel/acme-dns (0700 hp-executor:hp-executor) + /run/hosting-panel/host-jobs (0700 hp-agent:hp-agent)"
  for unit_name in "${REQUIRED_UNITS[@]}"; do
    log_dry "Would install /etc/systemd/system/${unit_name} (0644 root:root)"
  done
  log_dry "Would run: systemctl daemon-reload"
  log_dry "Would run: systemctl enable --now hp-unit-restart@hp-api.path hp-unit-restart@hp-web.path hp-unit-restart@hp-docker-executor.path hp-unit-restart@hp-host-agent.path hp-panel-update.path hp-os-refresh.path hp-os-upgrade.path"
  if [[ -r "${REPO_ROOT}/IMAGES" ]]; then
    while IFS= read -r image; do log_dry "Image (pulled by hp-docker-executor, never by this script): ${image}"; done <"${REPO_ROOT}/IMAGES"
  else
    log_dry "No image list: ${REPO_ROOT}/IMAGES is missing (a source tree, not a release)"
  fi
  log_dry "Ports: 22, 80, 443 accepted in the input chain of the base rules; 3000 (web console) from the Docker bridges only; 80, 443 (Traefik) and 2222 (site SFTP) published by Docker on all addresses, where of the base rules only the block list filters them; ports of a generic service published by Docker on 127.0.0.1 only; 127.0.0.1:4000 (API), 127.0.0.1:5432 (PostgreSQL), 127.0.0.1:8306 (phpMyAdmin) on loopback"
  log_info "Bootstrap dry-run completed successfully."
  exit 0
fi

# Live provisioning requires root privileges
if [[ "${EUID}" -ne 0 ]]; then
  fail "Live provisioning requires root privileges (re-run as root or pass --dry-run)."
fi

# 5b. OS packages this version needs and an older server lacks: only the missing ones, before anything changes.
MISSING_PACKAGES="$(missing_os_packages)"
if [[ -n "${MISSING_PACKAGES}" ]]; then
  log_info "Installing missing OS packages: ${MISSING_PACKAGES}"
  # shellcheck disable=SC2086 # a list of package names
  { DEBIAN_FRONTEND=noninteractive apt-get update -q &&
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${MISSING_PACKAGES}; } ||
    fail "Could not install the OS packages ${MISSING_PACKAGES}; nothing else was changed. Check the apt sources and the network, then run the update again."
fi

# 6. Provision hp-ipc group & dedicated non-root system users
if ! getent group hp-ipc >/dev/null 2>&1; then
  groupadd --system hp-ipc
  log_info "Created system group: hp-ipc"
fi

if ! getent group docker >/dev/null 2>&1; then
  fail "Group 'docker' does not exist; ensure Docker Engine is properly installed."
fi

ensure_system_user() {
  local username="$1"
  local supp_groups="${2:-}"

  if ! id -u "${username}" >/dev/null 2>&1; then
    useradd \
      --system \
      --user-group \
      --home-dir /nonexistent \
      --no-create-home \
      --shell "${NOLOGIN_SHELL}" \
      "${username}"
    log_info "Created system user: ${username}"
  else
    usermod --shell "${NOLOGIN_SHELL}" "${username}"
  fi

  if [[ -n "${supp_groups}" ]]; then
    usermod -a -G "${supp_groups}" "${username}"
  fi
}

ensure_system_user "hp-web" ""
ensure_system_user "hp-api" "hp-ipc"
ensure_system_user "hp-executor" "docker,hp-ipc"
ensure_system_user "hp-agent" "hp-ipc"
# Owns the shared MariaDB data dir and runs hp_mariadb (container User); never in docker.
ensure_system_user "hp-mariadb" ""

# 7. Provision /etc/hosting-panel & idempotent cryptographic keys
install -d -m 0750 -o root -g hp-ipc /etc/hosting-panel
install -m 0640 -o root -g hp-ipc "${NFTABLES_SRC_FILE}" /etc/hosting-panel/nftables-dedicated.conf
# The boot copy exists only where install.sh set the firewall up; an update keeps it current but never loads it.
if [[ -e /etc/nftables.d/hosting-panel.nft ]] && ! cmp -s "${NFTABLES_SRC_FILE}" /etc/nftables.d/hosting-panel.nft; then
  log_info "The base firewall rules changed in this version and are not loaded yet: on Administration > Firewall use Apply base rules."
fi
if [[ -e /etc/nftables.d/hosting-panel.nft ]]; then
  install -m 0644 -o root -g root "${NFTABLES_SRC_FILE}" /etc/nftables.d/hosting-panel.nft
fi

generate_32_byte_hex_key() {
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
}

IPC_KEY_PATH="/etc/hosting-panel/ipc.key"
if [[ ! -s "${IPC_KEY_PATH}" ]]; then
  tmp_ipc_key="$(mktemp /etc/hosting-panel/.ipc.key.XXXXXX)"
  chmod 0400 "${tmp_ipc_key}"
  printf '%s' "$(generate_32_byte_hex_key)" > "${tmp_ipc_key}"
  chown root:hp-ipc "${tmp_ipc_key}"
  chmod 0440 "${tmp_ipc_key}"
  mv -f "${tmp_ipc_key}" "${IPC_KEY_PATH}"
  log_info "Generated new 32-byte IPC key at ${IPC_KEY_PATH}"
else
  chown root:hp-ipc "${IPC_KEY_PATH}"
  chmod 0440 "${IPC_KEY_PATH}"
  log_info "Preserved existing IPC key at ${IPC_KEY_PATH} (0440)"
fi

SECRETS_MASTER_KEY_PATH="/etc/hosting-panel/secrets-master.key"
if [[ ! -s "${SECRETS_MASTER_KEY_PATH}" ]]; then
  tmp_master_key="$(mktemp /etc/hosting-panel/.secrets-master.key.XXXXXX)"
  chmod 0400 "${tmp_master_key}"
  printf '%s' "$(generate_32_byte_hex_key)" > "${tmp_master_key}"
  chown hp-api:root "${tmp_master_key}"
  chmod 0400 "${tmp_master_key}"
  mv -f "${tmp_master_key}" "${SECRETS_MASTER_KEY_PATH}"
  log_info "Generated new 32-byte AES-256-GCM master key at ${SECRETS_MASTER_KEY_PATH}"
else
  chown hp-api:root "${SECRETS_MASTER_KEY_PATH}"
  chmod 0400 "${SECRETS_MASTER_KEY_PATH}"
  log_info "Preserved existing AES-256-GCM master key at ${SECRETS_MASTER_KEY_PATH} (0400)"
fi

BREAKGLASS_KEY_PATH="/etc/hosting-panel/breakglass-jwt.key"
if [[ ! -s "${BREAKGLASS_KEY_PATH}" ]]; then
  tmp_bg_key="$(mktemp /etc/hosting-panel/.breakglass-jwt.key.XXXXXX)"
  chmod 0400 "${tmp_bg_key}"
  printf '%s' "$(generate_32_byte_hex_key)" > "${tmp_bg_key}"
  chown hp-api:root "${tmp_bg_key}"
  chmod 0400 "${tmp_bg_key}"
  mv -f "${tmp_bg_key}" "${BREAKGLASS_KEY_PATH}"
  log_info "Generated new 32-byte break-glass JWT signing key at ${BREAKGLASS_KEY_PATH}"
else
  chown hp-api:root "${BREAKGLASS_KEY_PATH}"
  chmod 0400 "${BREAKGLASS_KEY_PATH}"
  log_info "Preserved existing break-glass JWT signing key at ${BREAKGLASS_KEY_PATH} (0400)"
fi

JWT_KEY_PATH="/etc/hosting-panel/jwt-signing.pem"
if [[ ! -s "${JWT_KEY_PATH}" ]]; then
  tmp_jwt_key="$(mktemp /etc/hosting-panel/.jwt-signing.pem.XXXXXX)"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${tmp_jwt_key}" 2>/dev/null
  chown hp-api:root "${tmp_jwt_key}"
  chmod 0400 "${tmp_jwt_key}"
  mv -f "${tmp_jwt_key}" "${JWT_KEY_PATH}"
  log_info "Generated new RSA-3072 JWT signing key at ${JWT_KEY_PATH}"
else
  chown hp-api:root "${JWT_KEY_PATH}"
  chmod 0400 "${JWT_KEY_PATH}"
  log_info "Preserved existing JWT signing key at ${JWT_KEY_PATH} (0400)"
fi

# Readable by MariaDB (owner) and by the executor's setup jobs (group).
MARIADB_ROOT_KEY_PATH="/etc/hosting-panel/mariadb-root.key"
if [[ ! -s "${MARIADB_ROOT_KEY_PATH}" ]]; then
  tmp_db_key="$(mktemp /etc/hosting-panel/.mariadb-root.key.XXXXXX)"
  chmod 0400 "${tmp_db_key}"
  printf '%s' "$(generate_32_byte_hex_key)" > "${tmp_db_key}"
  chown hp-mariadb:hp-executor "${tmp_db_key}"
  chmod 0440 "${tmp_db_key}"
  mv -f "${tmp_db_key}" "${MARIADB_ROOT_KEY_PATH}"
  log_info "Generated new 32-byte MariaDB root key at ${MARIADB_ROOT_KEY_PATH}"
else
  chown hp-mariadb:hp-executor "${MARIADB_ROOT_KEY_PATH}"
  chmod 0440 "${MARIADB_ROOT_KEY_PATH}"
  log_info "Preserved existing MariaDB root key at ${MARIADB_ROOT_KEY_PATH} (0440)"
fi

# Restic repository password: read by the executor for backup jobs (group). Never regenerated: a new key makes every existing backup unreadable.
BACKUP_KEY_PATH="/etc/hosting-panel/backup.key"
if [[ ! -s "${BACKUP_KEY_PATH}" ]]; then
  tmp_backup_key="$(mktemp /etc/hosting-panel/.backup.key.XXXXXX)"
  chmod 0400 "${tmp_backup_key}"
  printf '%s' "$(generate_32_byte_hex_key)" > "${tmp_backup_key}"
  chown root:hp-executor "${tmp_backup_key}"
  chmod 0440 "${tmp_backup_key}"
  mv -f "${tmp_backup_key}" "${BACKUP_KEY_PATH}"
  log_info "Generated new 32-byte backup encryption key at ${BACKUP_KEY_PATH}"
else
  chown root:hp-executor "${BACKUP_KEY_PATH}"
  chmod 0440 "${BACKUP_KEY_PATH}"
  log_info "Preserved existing backup encryption key at ${BACKUP_KEY_PATH} (0440)"
fi

# Per-service env files (0400 root:root; systemd reads them as root). Created only if absent, from a temp file.
write_env_file() {
  local path="$1" content="$2" tmp
  if [[ -e "${path}" ]]; then
    log_info "Preserved existing ${path}"
    return
  fi
  tmp="$(mktemp /etc/hosting-panel/.env.XXXXXX)"
  printf '%s\n' "${content}" > "${tmp}"
  install -m 0400 -o root -g root "${tmp}" "${path}"
  rm -f "${tmp}"
  log_info "Created ${path} (0400 root:root)"
}

write_env_file /etc/hosting-panel/api.env "DATABASE_URL=
ENABLE_DEV_OIDC=false
HP_SEED_DEMO=false"
# Loopback placeholder: an empty value would make next listen on all interfaces; install.sh sets docker0.
write_env_file /etc/hosting-panel/web.env "BFF_SESSION_SECRET=$(generate_32_byte_hex_key)
API_INTERNAL_URL=http://127.0.0.1:4000
HP_WEB_BIND_ADDRESS=127.0.0.1"
write_env_file /etc/hosting-panel/executor.env "HP_PANEL_HOSTNAME=
HP_PANEL_IPV4=
HP_ACME_EMAIL=
HP_ACME_STAGING=false
HP_PANEL_UPSTREAM_PORT=3000"

install -m 0750 -o root -g root "${SCRIPT_DIR}/hp-accounts" /usr/local/sbin/hp-accounts
install -m 0750 -o root -g root "${SCRIPT_DIR}/hp-break-glass" /usr/local/sbin/hp-break-glass
install -m 0750 -o root -g root "${SCRIPT_DIR}/hp-update" /usr/local/sbin/hp-update
install -m 0750 -o root -g root "${SCRIPT_DIR}/hp-restore-panel" /usr/local/sbin/hp-restore-panel

# 8. Provision /var/lib/hosting-panel data hierarchy & /run/hosting-panel tmpfs (setgid+sticky 3770 root:hp-ipc)
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/ingress
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/ingress/static
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/ingress/dynamic
install -d -m 0700 -o hp-executor -g hp-executor /var/lib/hosting-panel/ingress/dynamic/manual-certs
install -d -m 0700 -o hp-executor -g hp-executor /var/lib/hosting-panel/ingress/acme
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/sites
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/mariadb
install -d -m 0700 -o hp-mariadb -g hp-mariadb /var/lib/hosting-panel/mariadb/data
install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/site-mail
install -d -m 0700 -o hp-executor -g hp-executor /var/lib/hosting-panel/sftp
install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/phpmyadmin
install -d -m 0700 -o hp-executor -g hp-executor /var/lib/hosting-panel/backups
# 2770: the executor runs with RestrictSUIDSGID=yes and cannot ask for the setgid bit, so the directories it creates
# here (<id>, sites/<site>, panel) inherit it, and the executor group, from this one.
install -d -m 2770 -o hp-executor -g hp-executor /var/lib/hosting-panel/local-repos
chmod 2770 /var/lib/hosting-panel/local-repos
# The API writes the panel copy here, the executor reads it (group hp-ipc via setgid).
install -d -m 2770 -o root -g hp-ipc /var/lib/hosting-panel/panel-dump
chmod 2770 /var/lib/hosting-panel/panel-dump

install -m 0644 -o root -g root "${SYSTEMD_SRC_DIR}/hosting-panel-tmpfiles.conf" /etc/tmpfiles.d/hosting-panel.conf
install -d -m 3770 -o root -g hp-ipc /run/hosting-panel
chmod 3770 /run/hosting-panel
install -d -m 0700 -o hp-executor -g hp-executor /run/hosting-panel/secrets
# 00755: a plain 0755 keeps the setgid bit inherited from the 3770 parent (GNU install).
install -d -m 00755 -o hp-executor -g hp-executor /run/hosting-panel/mail-relay
install -d -m 00700 -o hp-executor -g hp-executor /run/hosting-panel/acme-dns
# Host job trigger files: only the agent writes them; root path units watch them (ADR 0028).
install -d -m 00700 -o hp-agent -g hp-agent /run/hosting-panel/host-jobs

# 9. Install and reload systemd units
for unit_name in "${REQUIRED_UNITS[@]}"; do
  install -m 0644 -o root -g root "${SYSTEMD_SRC_DIR}/${unit_name}" "/etc/systemd/system/${unit_name}"
done

systemctl daemon-reload
# Before the quiet exit: an updated server gets the path units too. The services stay disabled.
systemctl enable --now hp-unit-restart@hp-api.path hp-unit-restart@hp-web.path hp-unit-restart@hp-docker-executor.path hp-unit-restart@hp-host-agent.path hp-panel-update.path hp-os-refresh.path hp-os-upgrade.path
log_info "Installed systemd units and reloaded systemd daemon successfully."

# The updater re-runs bootstrap on every update; the first-run hints are noise there.
[[ "${HP_BOOTSTRAP_QUIET:-0}" == 1 ]] && exit 0
cat <<'EOF'

Host prepared. To install the panel itself, run infra/linux/install.sh from a release
archive (see "Installazione su un nuovo server" in the README).
EOF
