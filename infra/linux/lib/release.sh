#!/usr/bin/env bash
# Release fetch/verify/install/swap/prune helpers. Source this file; functions return non-zero, never exit.
# Layout: <root>/releases/<version>/, <root>/current -> releases/<version>.

HP_RELEASE_REPO="${HP_RELEASE_REPO:-lollinoo/hosting-panel}"
HP_DEFAULT_ROOT="/opt/hosting-panel"

_hp_semver_re='^[0-9]+\.[0-9]+\.[0-9]+$'

release_asset_url() {
  printf 'https://github.com/%s/releases/download/v%s/hosting-panel-%s-linux-x64.tar.gz\n' \
    "${HP_RELEASE_REPO}" "$1" "$1"
}

# Prints the archive path.
fetch_release() {
  local version="$1" dest="$2" url archive
  [[ "${version}" =~ ${_hp_semver_re} ]] || { printf '[ERROR] Invalid version %s\n' "${version}" >&2; return 1; }
  url="$(release_asset_url "${version}")"
  archive="${dest}/hosting-panel-${version}-linux-x64.tar.gz"
  mkdir -p "${dest}" || return 1
  local f
  for f in "" ".sha256"; do
    if ! curl -fsSL --retry 3 --connect-timeout 15 --speed-time 30 --speed-limit 1024 \
      -o "${archive}${f}.part" "${url}${f}" || ! mv -f -- "${archive}${f}.part" "${archive}${f}"; then
      printf '[ERROR] Download failed: %s%s\n' "${url}" "${f}" >&2
      rm -f -- "${archive}.part" "${archive}.sha256.part" "${archive}.sha256" "${archive}"
      return 1
    fi
  done
  printf '%s\n' "${archive}"
}

# shortcut: checksum only, no signature — add minisign/cosign verification before third parties publish releases
verify_release_archive() {
  local archive="$1" dir base
  dir="$(dirname -- "${archive}")"
  base="$(basename -- "${archive}")"
  if [[ ! -f "${archive}" || ! -f "${archive}.sha256" ]]; then
    printf '[ERROR] Missing archive or checksum file for %s\n' "${archive}" >&2
    return 1
  fi
  local named
  named="$(awk 'NR==1{n=$2; sub(/^\*/,"",n); print n}' "${archive}.sha256")"
  if [[ "${named}" != "${base}" ]]; then
    printf '[ERROR] Checksum file names %s, expected %s\n' "${named}" "${base}" >&2
    return 1
  fi
  (cd "${dir}" && sha256sum -c "${base}.sha256" >/dev/null 2>&1) || {
    printf '[ERROR] Checksum mismatch for %s\n' "${archive}" >&2
    return 1
  }
}

# Copies an operator-supplied archive and its .sha256 into <dir> (a private mktemp -d) and prints
# the copy's path: verify and install then read only the copy, so the original cannot be swapped
# between the checksum check and the extraction.
stage_release_archive() { # <archive> <dir>
  local dest
  dest="$2/$(basename -- "$1")"
  if ! cp -- "$1" "${dest}" || ! cp -- "$1.sha256" "${dest}.sha256"; then
    printf '[ERROR] Cannot copy %s and its .sha256\n' "$1" >&2
    return 1
  fi
  printf '%s\n' "${dest}"
}

# Succeeds when the archive's hosting-panel-<version>/VERSION equals <version> (the one its file
# name claims): a mislabelled archive must never be installed under, or over, another version.
archive_has_version() { # <archive> <version>
  local v
  v="$(tar -xzOf "$1" "hosting-panel-$2/VERSION" 2>/dev/null | tr -d '[:space:]')" || v=""
  [[ -n "${v}" && "${v}" == "$2" ]]
}

# Prints the installed version. Code must be readable by the service users whatever the
# caller's umask (installer uses 027): extract under umask 022 in a subshell.
install_release() { (umask 022 && _hp_install_release "$@"); }

_hp_install_release() {
  local archive="$1" root="${2:-${HP_DEFAULT_ROOT}}" tmp top version
  mkdir -p "${root}/releases" && chmod 0755 "${root}" "${root}/releases" || return 1
  tmp="$(mktemp -d "${root}/releases/.tmp-XXXXXX")" || return 1
  if ! tar -xzf "${archive}" --no-same-owner --no-same-permissions -C "${tmp}"; then
    printf '[ERROR] Failed to extract %s\n' "${archive}" >&2
    rm -rf -- "${tmp}"
    return 1
  fi
  local entries=("${tmp}"/* "${tmp}"/.[!.]*)
  local existing=() e
  for e in "${entries[@]}"; do [[ -e "${e}" || -L "${e}" ]] && existing+=("${e}"); done
  top="${existing[0]:-}"
  if [[ ${#existing[@]} -ne 1 || ! -d "${top}" || -L "${top}" || ! -f "${top}/VERSION" ]]; then
    printf '[ERROR] Archive must contain a single hosting-panel-<version>/ directory with VERSION\n' >&2
    rm -rf -- "${tmp}"
    return 1
  fi
  version="$(tr -d '[:space:]' <"${top}/VERSION")"
  if [[ ! "${version}" =~ ${_hp_semver_re} || "$(basename -- "${top}")" != "hosting-panel-${version}" ]]; then
    printf '[ERROR] Archive directory %s does not match VERSION %s\n' "$(basename -- "${top}")" "${version}" >&2
    rm -rf -- "${tmp}"
    return 1
  fi
  if [[ -e "${root}/releases/${version}" ]]; then
    if [[ "${version}" == "$(current_version "${root}")" ]]; then
      printf '[ERROR] Release %s is the current release; refusing to replace it\n' "${version}" >&2
      rm -rf -- "${tmp}"
      return 1
    fi
    if [[ "${HP_FORCE_REINSTALL:-0}" != "1" ]]; then
      printf '[ERROR] Release %s already installed (set HP_FORCE_REINSTALL=1 to replace)\n' "${version}" >&2
      rm -rf -- "${tmp}"
      return 1
    fi
    mv -T -- "${root}/releases/${version}" "${tmp}/old" || { rm -rf -- "${tmp}"; return 1; }
  fi
  if ! mv -T -- "${top}" "${root}/releases/${version}"; then
    [[ -e "${tmp}/old" ]] && mv -T -- "${tmp}/old" "${root}/releases/${version}"
    rm -rf -- "${tmp}"
    return 1
  fi
  rm -rf -- "${tmp}"
  printf '%s\n' "${version}"
}

current_version() {
  local root="${1:-${HP_DEFAULT_ROOT}}" target
  target="$(readlink -- "${root}/current" 2>/dev/null)" || target=""
  [[ -n "${target}" ]] && basename -- "${target}"
  return 0
}

swap_current() {
  local root="${1:-${HP_DEFAULT_ROOT}}" version="$2"
  if [[ ! "${version}" =~ ${_hp_semver_re} || ! -d "${root}/releases/${version}" ]]; then
    printf '[ERROR] Release %s is not installed\n' "${version}" >&2
    return 1
  fi
  ln -sfn "releases/${version}" "${root}/current.new" && mv -T -- "${root}/current.new" "${root}/current"
}

version_gt() {
  local a b i
  [[ "$1" =~ ${_hp_semver_re} && "$2" =~ ${_hp_semver_re} ]] || return 1
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    ((10#${a[i]} > 10#${b[i]})) && return 0
    ((10#${a[i]} < 10#${b[i]})) && return 1
  done
  return 1
}

prune_releases() {
  local root="${1:-${HP_DEFAULT_ROOT}}" keep="${2:-3}" cur v n=0
  [[ "${keep}" =~ ^[0-9]+$ ]] || { printf '[ERROR] Invalid keep count %s\n' "${keep}" >&2; return 1; }
  cur="$(current_version "${root}")"
  [[ -d "${root}/releases" ]] || return 0
  # Protected releases (current, HP_KEEP_EXTRA) use up part of the keep budget; the rest go newest first.
  # Only strict semver dirs are candidates (.tmp-* and others are ignored).
  local all=() p=0
  while IFS= read -r v; do
    all+=("${v}")
    [[ "${v}" == "${cur}" || "${v}" == "${HP_KEEP_EXTRA:-}" ]] && p=$((p + 1))
  done < <(_hp_list_releases "${root}")
  for v in "${all[@]}"; do
    [[ "${v}" == "${cur}" || "${v}" == "${HP_KEEP_EXTRA:-}" ]] && continue
    n=$((n + 1))
    ((n <= keep - p)) && continue
    rm -rf -- "${root}/releases/${v}"
  done
}

_hp_list_releases() {
  local root="$1" d v
  for d in "${root}"/releases/*/; do
    v="$(basename -- "${d}")"
    [[ -d "${root}/releases/${v}" && ! -L "${root}/releases/${v}" && "${v}" =~ ${_hp_semver_re} ]] && printf '%s\n' "${v}"
  done | sort -t. -k1,1nr -k2,2nr -k3,3nr
}
