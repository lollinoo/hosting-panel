#!/usr/bin/env bash
# ==============================================================================
# Hosting Panel — bring the panel back on a new server from its copy in the S3 bucket or on the old disk.
# Installed as /usr/local/sbin/hp-restore-panel (a wrapper that runs the current release's copy).
# ==============================================================================
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo hp-restore-panel --endpoint <url> --region <region> --bucket <bucket> [--prefix <path>] [--yes]
       sudo hp-restore-panel --local-repo <panel repository folder> [--yes]

Brings back the panel's accounts, sites and settings from the copy the old server kept in the
bucket, or in the panel repository of a local backup target on its old disk (mount the disk first;
the folder is <root>/<target id>/panel, for instance /mnt/old/local-repos/bkt_<32 hex>/panel).
--local-repo cannot be combined with the bucket options, never asks for S3 keys, and reads the
disk without changing it. Run it on a new server right after install.sh, once the old server's backup.key is back
in /etc/hosting-panel/backup.key (0440 root:hp-executor). Switch the old server off first.
With a bucket, the S3 keys are taken from HP_S3_ACCESS_KEY_ID and HP_S3_SECRET_ACCESS_KEY when
set, otherwise they are asked for; never pass them as arguments. Before anything is changed it shows the date of
the copy and asks y/N; --yes answers yes (without a terminal and without --yes the answer is no).

Exit codes: 0 panel restored, 1 a step failed (the message says what to do; running again is safe),
2 refused: bad arguments (a --local-repo folder that is a relative path, has a symlink, belongs
to root, is writable by everybody or is not a restic repository), not root, no backup.key, sites
or applications already on this server, a copy made by a newer panel, or the question not answered y.
EOF
}

# The keys stay in this shell only: runuser would pass an exported variable on to every child.
ak="${HP_S3_ACCESS_KEY_ID:-}"
sk="${HP_S3_SECRET_ACCESS_KEY:-}"
unset HP_S3_ACCESS_KEY_ID HP_S3_SECRET_ACCESS_KEY

SCRIPT_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

die() { printf '[ERROR] %s\n' "$2" >&2; exit "$1"; }
info() { printf '[INFO] %s\n' "$1"; }
SAFE="Nothing on this server was changed; running this again is safe."
STOPPED="The panel is stopped: run this again (it is safe), or start the empty panel with systemctl start hp-api hp-web."

endpoint="" region="" bucket="" prefix="" has_prefix=0 assume_yes=0 local_repo="" has_local=0
while (($#)); do
  case "$1" in
    --endpoint | --region | --bucket | --prefix | --local-repo)
      [[ $# -ge 2 && -n "$2" ]] || { usage >&2; die 2 "$1 needs a value"; }
      case "$1" in
        --endpoint) endpoint="$2" ;;
        --region) region="$2" ;;
        --bucket) bucket="$2" ;;
        --prefix) prefix="$2"; has_prefix=1 ;;
        --local-repo) local_repo="$2"; has_local=1 ;;
      esac
      shift 2
      ;;
    --yes) assume_yes=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die 2 "Unknown argument: $1" ;;
  esac
done
if ((has_local)); then
  [[ -z "${endpoint}${region}${bucket}" && ${has_prefix} -eq 0 ]] ||
    { usage >&2; die 2 "--local-repo cannot be combined with --endpoint, --region, --bucket or --prefix."; }
else
  [[ -n "${endpoint}" && -n "${region}" && -n "${bucket}" ]] ||
    { usage >&2; die 2 "Give --local-repo, or --endpoint, --region and --bucket."; }
fi

# Test overrides (stubs). Only honoured as non-root, where they cannot touch the real system.
if [[ "${EUID}" -eq 0 ]]; then
  for o in HP_ROOT HP_SYSTEMCTL HP_HEALTH_CMD HP_PG_BIN; do
    [[ -z "${!o:-}" ]] || die 2 "${o} is a test override and is refused when running as root"
  done
elif [[ -z "${HP_ROOT:-}" ]]; then
  die 2 "Run as root (sudo)."
fi
R="${HP_ROOT:-}"
ETC="${R}/etc/hosting-panel"
STATE="${R}/var/lib/hosting-panel"
RELEASE="${R}/opt/hosting-panel/current"
DUMP_DIR="${STATE}/panel-dump"
DUMP="${DUMP_DIR}/restore.pgdump"
KEY="${DUMP_DIR}/restore.key"
MARKER="${STATE}/panel-restore.pending"
PG_BIN="${HP_PG_BIN:-/usr/lib/postgresql/18/bin}"
SYSTEMCTL="${HP_SYSTEMCTL:-systemctl}"

as() { local u="$1"; shift; (cd / && runuser -u "${u}" -- "$@"); } # cd /: the user may not read root's cwd
health() {
  if [[ -n "${HP_HEALTH_CMD:-}" ]]; then "${HP_HEALTH_CMD}"; else
    local bind
    bind="$(env_value "${ETC}/web.env" HP_WEB_BIND_ADDRESS)"
    panel_health_check "${bind:-127.0.0.1}" 90
  fi
}
# The panel repository on the old disk: refused unless it is a plain, root-free restic folder, before anything runs.
check_local_repo() {
  local d="$1" c="" part x st m refusal
  local -a parts
  refusal="The --local-repo folder was refused. It must be the panel repository of a local backup target: an absolute path of letters, digits and . _ @ + - / with no symlink, .. or trailing slash, such as /mnt/old/local-repos/bkt_<32 hex>/panel, not owned by root, not writable by everybody, and holding a restic repository (config, keys, data, snapshots, index). ${SAFE}"
  [[ ${#d} -le 255 && "${d}" =~ ^/[A-Za-z0-9._@+/-]+$ && "${d}" != */ && "${d}" != *//* && "${d}" != */./* && "${d}" != */. &&
    "${d}" != */../* && "${d}" != */.. ]] || die 2 "${refusal}"
  for x in /etc /proc /sys /dev /run /boot /root /var/lib/docker; do
    [[ "${d}" != "${x}" && "${d}" != "${x}/"* ]] || die 2 "${refusal}"
  done
  # This server's own state (panel dump, secrets, site files) is never a source; the local-repos folder of a reinstall is.
  if [[ "${d}" == "${STATE}" || "${d}" == "${STATE}/"* ]]; then
    [[ "${d}" == "${STATE}/local-repos/"* ]] || die 2 "${refusal}"
  fi
  IFS=/ read -ra parts <<<"${d#/}"
  for part in "${parts[@]}"; do
    c+="/${part}"
    [[ ! -L "${c}" ]] || die 2 "${refusal}"
    [[ -e "${c}" ]] || die 1 "${d} cannot be found. Mount the old disk first (and check the path of the panel folder), then run this again. ${SAFE}"
  done
  [[ -d "${d}" && "$(readlink -f -- "${d}")" == "${d}" ]] || die 2 "${refusal}"
  st="$(stat -c '%u %a' -- "${d}")"
  [[ "${st%% *}" != 0 ]] && ((!(8#${st#* } & 2))) || die 2 "${refusal}"
  m="$(stat -c '%u %a' -- "${d}/config" 2>/dev/null)" || die 2 "${refusal}"
  [[ -f "${d}/config" && ! -L "${d}/config" && "${m%% *}" == "${st%% *}" ]] && ((!(8#${m#* } & 2))) || die 2 "${refusal}"
  for x in keys data snapshots index; do
    [[ -d "${d}/${x}" && ! -L "${d}/${x}" ]] || die 2 "${refusal}"
  done
}
trap 'rm -f -- "${DUMP}" "${KEY}"' EXIT

# 1. Checks that change nothing.
[[ -s "${ETC}/backup.key" && "$(<"${ETC}/backup.key")" =~ ^[0-9a-f]{64}$ ]] ||
  die 2 "Put the old server's backup.key in ${ETC}/backup.key (0440 root:hp-executor) first, then run this again."
((!has_local)) || check_local_repo "${local_repo}"
hostname="$(env_value "${ETC}/executor.env" HP_PANEL_HOSTNAME)"
ipv4="$(env_value "${ETC}/executor.env" HP_PANEL_IPV4)"
[[ -n "${hostname}" && -n "${ipv4}" ]] || die 1 "Run install.sh on this server first: ${ETC}/executor.env has no panel hostname or address. ${SAFE}"
# The copy is loaded as the panel's own user, never as a superuser: a copy runs what its maker put in it.
[[ -r "${ETC}/api.env" ]] || die 1 "Run install.sh on this server first: ${ETC}/api.env is missing. ${SAFE}"
db_url="$(env_value "${ETC}/api.env" DATABASE_URL)"
[[ -n "${db_url}" ]] || die 1 "Run install.sh on this server first: ${ETC}/api.env has no DATABASE_URL. ${SAFE}"
# install.sh writes a hex password, so the unreserved characters below need no percent-decoding.
[[ "${db_url}" =~ ^postgresql://hosting_panel:([A-Za-z0-9._~-]+)@127\.0\.0\.1:5432/hosting_panel$ ]] ||
  die 1 "DATABASE_URL in ${ETC}/api.env is not the one install.sh writes (postgresql://hosting_panel:<password>@127.0.0.1:5432/hosting_panel). Put that form back, then run this again. ${SAFE}"
db_pw="${BASH_REMATCH[1]}"
unset db_url
# The marker means an earlier run of this script already dropped this server's panel database.
if [[ ! -e "${MARKER}" ]]; then
  # As the panel's user too: after a complete restore this database was built from the copy.
  # A server older than application stacks has no app_stacks table: query_to_xml reads it only where it exists.
  counts="$(PGPASSWORD="${db_pw}" "${PG_BIN}/psql" -X -tAc "SELECT (SELECT count(*) FROM public.sites), CASE WHEN to_regclass('public.app_stacks') IS NULL THEN 0 ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM public.app_stacks WHERE deleted_at IS NULL', false, true, '')))[1]::text::bigint END" -h 127.0.0.1 -U hosting_panel -d hosting_panel)" ||
    die 1 "Cannot read the panel database. Check that PostgreSQL is running (systemctl status postgresql), that the password in DATABASE_URL of ${ETC}/api.env is the one of the database user hosting_panel and that install.sh ran to the end, then run this again. ${SAFE}"
  # A crafted copy can make count(*) answer any text: never print it.
  [[ "${counts}" =~ ^([0-9]+)\|([0-9]+)$ ]] || die 1 "The panel database gave an unexpected answer to the site count. ${SAFE}"
  sites="${BASH_REMATCH[1]}" stacks="${BASH_REMATCH[2]}"
  [[ "${sites}" == "0" ]] || die 2 "This panel already has ${sites} site(s): bringing back a copy would erase them. Run this only on a freshly installed server."
  [[ "${stacks}" == "0" ]] || die 2 "This panel already has ${stacks} application(s): bringing back a copy would erase them. Run this only on a freshly installed server."
fi
if ((!has_local)); then
  [[ -n "${ak}" ]] || read -rp "S3 access key ID: " ak || true
  [[ -n "${sk}" ]] || { read -rsp "S3 secret access key: " sk || true; echo; }
  [[ -n "${ak}" && -n "${sk}" ]] || die 2 "No S3 keys: set HP_S3_ACCESS_KEY_ID and HP_S3_SECRET_ACCESS_KEY, or type them when asked."
fi

# 2. Fetch the newest copy: the executor's command writes restore.pgdump and restore.key.
# The keys go on its stdin from a builtin, so they are in no argument list and no environment.
# A local repository takes no key: the fetch gets an empty stdin.
if ((has_local)); then
  src="the local repository"
  info "Fetching the newest copy of the panel from ${local_repo}..."
  rc=0
  fetched="$(HP_PANEL_DUMP_DIR="${DUMP_DIR}" as hp-executor /usr/bin/node "${RELEASE}/apps/docker-executor/dist/cli/panel-fetch.js" --local-repo "${local_repo}" </dev/null)" ||
    rc=$?
else
  src="the bucket"
  info "Fetching the newest copy of the panel from the bucket..."
  fetch_args=(--endpoint "${endpoint}" --region "${region}" --bucket "${bucket}")
  ((has_prefix == 0)) || fetch_args+=(--prefix "${prefix}")
  rc=0
  fetched="$(printf '%s\n%s\n' "${ak}" "${sk}" |
    HP_PANEL_DUMP_DIR="${DUMP_DIR}" as hp-executor /usr/bin/node "${RELEASE}/apps/docker-executor/dist/cli/panel-fetch.js" "${fetch_args[@]}")" ||
    rc=$?
fi
if ((has_local)); then
  case "${rc}" in
    0) ;;
    2) die 1 "The --local-repo folder was refused. It must be an absolute path without symlinks or .., such as /mnt/old/local-repos/<id>/panel. ${SAFE}" ;;
    4) die 1 "No copy of the panel in that repository. Check that --local-repo is the panel folder of the target (not the local-repos folder), then run this again. ${SAFE}" ;;
    5) die 1 "The copy cannot be opened with ${ETC}/backup.key. Put the old server's backup.key there, then run this again. ${SAFE}" ;;
    6) die 1 "Not enough free space in ${DUMP_DIR} for the copy. Free disk space (df -h ${STATE}), then run this again. ${SAFE}" ;;
    7) die 1 "That folder cannot be found. Mount the old disk first, then run this again. ${SAFE}" ;;
    8) die 1 "That folder is not safe to read: a symlink, owned by root, writable by everybody, or a parent folder the hp-executor user cannot enter (chmod o+x on it). Fix the folder, then run this again. ${SAFE}" ;;
    *) die 1 "Fetching the copy failed (see the line above). Check journalctl -u hp-docker-executor and that install.sh of this release ran completely, then run this again. ${SAFE}" ;;
  esac
fi
case "${rc}" in
  0) ;;
  2) die 1 "The bucket settings were refused. --endpoint must be https://host or https://host:port with no path or trailing slash, --bucket lower-case letters, digits, dots and dashes, --prefix folder names of letters, digits, dots, dashes and underscores separated by /. Correct them, then run this again. ${SAFE}" ;;
  3) die 1 "The bucket cannot be reached or refused the keys. Check --endpoint, --region, --bucket and the S3 keys, then run this again. ${SAFE}" ;;
  4) die 1 "No copy of the panel at that place in the bucket. Check --bucket and --prefix (the backup path of the old server), then run this again. ${SAFE}" ;;
  5) die 1 "The copy cannot be opened with ${ETC}/backup.key. Put the old server's backup.key there, then run this again. ${SAFE}" ;;
  6) die 1 "Not enough free space in ${DUMP_DIR} for the copy. Free disk space (df -h ${STATE}), then run this again. ${SAFE}" ;;
  *) die 1 "Fetching the copy failed (see the line above). Check journalctl -u hp-docker-executor and that install.sh of this release ran completely, then run this again. ${SAFE}" ;;
esac
copy_time=""
[[ "${fetched}" =~ \"time\":\"([0-9T:.Z+-]+)\" ]] && copy_time="${BASH_REMATCH[1]}"
[[ -n "${copy_time}" && -s "${DUMP}" && -s "${KEY}" && "$(<"${KEY}")" =~ ^[0-9a-f]{64}$ ]] ||
  die 1 "The fetched copy is incomplete. Run this again; if it repeats, check journalctl -u hp-docker-executor. ${SAFE}"

# 3. Refuse a copy made by a newer panel: every migration it applied must ship with this release.
applied="$("${PG_BIN}/pg_restore" --data-only --table=schema_migrations --file=- "${DUMP}" |
  awk -F'\t' '/^COPY public\.schema_migrations /{on=1;next} /^\\\.$/{on=0} on{print $1}')" ||
  die 1 "The copy cannot be read. Run this again; if it repeats, the newest copy in the bucket is damaged. ${SAFE}"
[[ -n "${applied}" ]] || die 1 "The copy holds no panel database. Check --prefix, then run this again. ${SAFE}"
while IFS= read -r m; do
  [[ "${m}" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || die 1 "The copy lists an unexpected migration name; it is damaged or not a panel copy. Check --prefix. ${SAFE}"
  [[ -f "${RELEASE}/packages/database/dist/migrations/${m}" ]] ||
    die 2 "This copy was made by a newer panel (migration ${m}). Install that version first (hp-update --version <v>), then run this again."
done <<<"${applied}"

# 4. Replace this server's empty panel with the copy, once the administrator agreed to its date.
info "The newest copy in ${src} was made on ${copy_time} (UTC)."
if ((assume_yes == 0)); then
  answer=""
  [[ ! -t 0 ]] || read -rp "Replace this server's panel with this copy? [y/N] " answer || true
  [[ "${answer}" == [yY] ]] || die 2 "Not confirmed. ${SAFE} To go on, run it again and answer y (or add --yes)."
fi
"${SYSTEMCTL}" stop hp-web hp-api || die 1 "Stopping the panel failed. Check systemctl status hp-api hp-web. ${STOPPED}"
install -m 0400 -o hp-api -g root "${KEY}" "${ETC}/secrets-master.key" ||
  die 1 "Placing the panel key in ${ETC}/secrets-master.key failed. Check that ${ETC} is writable. ${STOPPED}"
: >"${MARKER}" # from here a run that fails part way may be repeated past the site count
as postgres "${PG_BIN}/dropdb" --force --if-exists hosting_panel ||
  die 1 "Removing the empty panel database failed. Check systemctl status postgresql, then run this again (it is safe); the panel stays stopped until it succeeds."
as postgres "${PG_BIN}/createdb" -O hosting_panel hosting_panel ||
  die 1 "Creating the panel database failed. Check systemctl status postgresql, then run this again (it is safe); the panel stays stopped until it succeeds."
PGPASSWORD="${db_pw}" "${PG_BIN}/pg_restore" -h 127.0.0.1 -U hosting_panel --dbname=hosting_panel --no-owner --exit-on-error <"${DUMP}" ||
  die 1 "Loading the copy failed (see above); the panel stays stopped. If df -h shows no room left on this server, free disk space and run this again (it is safe). If there is room, the panel's database user cannot load this copy, so it is not a plain panel copy and may have been tampered with: do not use it."

# 5. Migrate to this release and point the host at this server (as install.sh step 11 does).
"${R}/usr/local/sbin/hp-accounts" setup --name "${hostname}" --hostname "${hostname}" --ipv4 "${ipv4}" ||
  die 1 "Updating the copy to this release failed (see above). Run this again (it is safe); the panel stays stopped until it succeeds."

# 6. Close what the old server left unfinished (the same file accept-m3-panel.mjs runs).
PGPASSWORD="${db_pw}" "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 --single-transaction -h 127.0.0.1 -U hosting_panel -d hosting_panel -f - \
  <"${RELEASE}/infra/linux/hp-restore-panel.sql" ||
  die 1 "Closing the old server's unfinished work failed (see above). Run this again (it is safe); the panel stays stopped until it succeeds."
rm -f -- "${MARKER}"

# 7. Start the panel.
"${SYSTEMCTL}" start hp-api hp-web || die 1 "The panel was restored but did not start. Check journalctl -u hp-api -u hp-web, then systemctl start hp-api hp-web."
health || die 1 "The panel was restored but did not come up. Check journalctl -u hp-api -u hp-web, then systemctl restart hp-api hp-web."
cat <<EOF

Panel restored from the copy in ${src}. Next:
  1. Sign in with the old server's administrator account (the accounts install.sh made here are
     gone, and everybody signs in again).
  2. Point every site's domains at this server (${ipv4}).
  3. In Administration > Backups use "Restore" on each site to bring back its files and databases.
  4. Keep a copy of ${ETC}/backup.key off this server, as before.
EOF
