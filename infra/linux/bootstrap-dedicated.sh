#!/usr/bin/env bash
# ==============================================================================
# HCP-SPEC-003 §9.1 — Idempotent Dedicated Host Bootstrap Script
# Target: Ubuntu 24.04 LTS / Debian 12 (kernel 6.x+, cgroups v2, Docker Engine)
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

if [[ ! -r /etc/os-release ]]; then
  fail "Missing /etc/os-release; cannot verify Linux distribution."
fi

# shellcheck source=/dev/null
. /etc/os-release

DISTRO_ID="${ID:-unknown}"
DISTRO_VERSION="${VERSION_ID:-unknown}"

if [[ "${DISTRO_ID}" == "ubuntu" && "${DISTRO_VERSION}" == "24.04" ]]; then
  log_info "Verified supported OS: Ubuntu ${DISTRO_VERSION} LTS"
elif [[ "${DISTRO_ID}" == "debian" && "${DISTRO_VERSION}" == "12" ]]; then
  log_info "Verified supported OS: Debian ${DISTRO_VERSION}"
elif [[ "${ALLOW_OTHER_LINUX}" -eq 1 ]]; then
  log_info "Non-target Linux distribution allowed via --allow-other-linux (${DISTRO_ID} ${DISTRO_VERSION})"
else
  fail "Unsupported distribution '${DISTRO_ID} ${DISTRO_VERSION}'. Expected Ubuntu 24.04 LTS or Debian 12 (use --allow-other-linux for lab hosts)."
fi

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
  log_dry "Would ensure system group: hp-ipc"
  log_dry "Would ensure system users (${NOLOGIN_SHELL}): hp-web, hp-api (hp-ipc), hp-executor (docker,hp-ipc), hp-agent (hp-ipc)"
  log_dry "Would ensure directory /etc/hosting-panel (0750 root:hp-ipc)"
  log_dry "Would install /etc/hosting-panel/nftables-dedicated.conf (0640 root:hp-ipc)"
  log_dry "Would idempotently provision 32-byte key /etc/hosting-panel/ipc.key (0440 root:hp-ipc)"
  log_dry "Would idempotently provision 32-byte key /etc/hosting-panel/secrets-master.key (0400 hp-api:root)"
  log_dry "Would ensure directories /var/lib/hosting-panel/{ingress/static,ingress/dynamic,sites} (0750)"
  log_dry "Would ensure tmpfs runtime directories /run/hosting-panel (0750) and /run/hosting-panel/secrets (0700)"
  for unit_name in "${REQUIRED_UNITS[@]}"; do
    log_dry "Would install /etc/systemd/system/${unit_name} (0644 root:root)"
  done
  log_dry "Would run: systemctl daemon-reload"
  log_info "Bootstrap dry-run completed successfully."
  exit 0
fi

# Live provisioning requires root privileges
if [[ "${EUID}" -ne 0 ]]; then
  fail "Live provisioning requires root privileges (re-run as root or pass --dry-run)."
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

# 7. Provision /etc/hosting-panel & idempotent cryptographic keys
install -d -m 0750 -o root -g hp-ipc /etc/hosting-panel
install -m 0640 -o root -g hp-ipc "${NFTABLES_SRC_FILE}" /etc/hosting-panel/nftables-dedicated.conf

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

# 8. Provision /var/lib/hosting-panel data hierarchy & /run/hosting-panel tmpfs
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/ingress
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/ingress/static
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/ingress/dynamic
install -d -m 0750 -o hp-executor -g hp-ipc /var/lib/hosting-panel/sites

install -d -m 0750 -o root -g hp-ipc /run/hosting-panel
install -d -m 0700 -o hp-executor -g hp-executor /run/hosting-panel/secrets

# 9. Install and reload systemd units
for unit_name in "${REQUIRED_UNITS[@]}"; do
  install -m 0644 -o root -g root "${SYSTEMD_SRC_DIR}/${unit_name}" "/etc/systemd/system/${unit_name}"
done

systemctl daemon-reload
log_info "Installed systemd units and reloaded systemd daemon successfully."
