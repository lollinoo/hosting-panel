#!/usr/bin/env bash
# Supported OS detection. Source this file; never exits, only returns.
# Reads HP_OS_RELEASE_FILE (default /etc/os-release); HP_ALLOW_OTHER_LINUX=1 accepts other distros.

HP_SUPPORTED_OS="ubuntu:noble (24.04) ubuntu:resolute (26.04) debian:bookworm (12) debian:trixie (13)"

# Prints "ID VERSION_CODENAME" on success.
detect_supported_os() {
  local file="${HP_OS_RELEASE_FILE:-/etc/os-release}"
  if [[ ! -r "${file}" ]]; then
    printf '[ERROR] Missing %s; cannot verify Linux distribution.\n' "${file}" >&2
    return 1
  fi
  local id codename
  id="$(. "${file}" && printf '%s' "${ID:-unknown}")"
  codename="$(. "${file}" && printf '%s' "${VERSION_CODENAME:-unknown}")"
  case "${id}:${codename}" in
    ubuntu:noble | ubuntu:resolute | debian:bookworm | debian:trixie) ;;
    *)
      if [[ "${HP_ALLOW_OTHER_LINUX:-0}" != "1" ]]; then
        printf '[ERROR] Unsupported distribution %s %s. Supported: %s (use --allow-other-linux for lab hosts).\n' \
          "${id}" "${codename}" "${HP_SUPPORTED_OS}" >&2
        return 1
      fi
      ;;
  esac
  printf '%s %s\n' "${id}" "${codename}"
}

# OS packages the panel needs: install.sh installs them all, the bootstrap adds the missing ones on an update.
# libatomic1: the official Node 26 linux-x64 binary links against it; minimal images lack it.
HP_OS_PACKAGES=(curl ca-certificates gnupg nftables openssl tar xz-utils iproute2 libatomic1 unattended-upgrades)

pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }

# Prints the packages of HP_OS_PACKAGES that are not installed, space separated (empty when none).
missing_os_packages() {
  local p missing=()
  for p in "${HP_OS_PACKAGES[@]}"; do pkg_installed "${p}" || missing+=("${p}"); done
  printf '%s' "${missing[*]}"
}
