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
