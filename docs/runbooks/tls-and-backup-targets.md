# Runbook — manual TLS certificates and backup destinations

Operator procedures for HCP-SPEC-004 (SPEC §15.2). Ten procedures, numbered 1–10, in the order of the spec. The Italian
README (`README.md`, sections "Certificati caricati a mano", "Destinazioni" and "Procedure operative") carries the same
ten procedures.

Design records: `docs/architecture/adr/0031-manual-tls-certificates.md` (TLS) and
`docs/architecture/adr/0032-backup-targets.md` (backup destinations). Acceptance evidence and what is still pending:
`docs/security/hcp-spec-004-acceptance-report.md`.

## Scope and limits (read first)

- **Certificates are PEM only.** PKCS#12/PFX import is **not available**: Node has no PKCS#12 parser and a parser
  dependency needs the project owner's approval (BLOCKED #3). The interface never offers PFX; pasting a PKCS#12 is refused
  with `CERTIFICATE_FORMAT_UNSUPPORTED` (reason `not_pem`).
- **Encrypted `.zip.age` export is not available** (`encryptedBackupExportAvailable: false`): no `age` tool is approved
  and pinned (BLOCKED #4). The API refuses `format: "zip.age"` with `422 NOT_SUPPORTED`; the interface does not offer it.
  Only the plain ZIP download exists (procedure 8).
- A certificate is never renewed or revoked by the panel: no ACME for imported certificates, no OCSP/CRL. The panel warns
  at 30, 14, 7 and 0 days (see procedure 2).
- Not yet proven here (owner action, see the acceptance report): a run against a real S3 bucket, a host reboot, a
  certificate bought from a commercial CA, and the two root-only filesystem cases (read-only and full disk) of
  `infra/linux/accept-backup-local.mjs`.

Shell conventions: commands run as `root` (or with `sudo`) on the panel server. `<host>` is a hostname served by the
panel, `<ip>` the server's public IPv4.

---

## 1. Import a commercial PEM certificate, validate it and assign it to a domain that used Let's Encrypt

Where: customer **Sites › (site) › Domini** (permission `site.certificates.manage`), or the administrator's
**Certificati** page (inventory of all certificates, import for a chosen site).

1. In **Domini**, for the address choose the origin «Certificato importato», then «Importa un nuovo certificato…».
2. Paste three separate PEM texts: the leaf certificate, the intermediates in order (leave empty if none), and the
   unencrypted private key (RSA 2048–8192 or EC P-256/P-384). At most 512 KiB in total. The key is sent once and never shown
   again.
3. The panel validates before saving: key matches the leaf; the leaf is not a CA and allows `serverAuth`; dates valid with a
   24 h margin; the names come from the SAN list (the CN must also be in the SANs; IP SANs are refused; a wildcard covers one
   level only); the chain builds to a public Mozilla root. A refusal carries a fixed reason (for example `key_mismatch`,
   `untrusted_or_incomplete`, `expired`, `cn_not_in_san`) and never echoes the pasted text.
4. Confirm the assignment. The previous certificate keeps being served until the proxy proves the new one: the version
   becomes `active` only after a real TLS handshake on the proxy shows the expected SHA-256 fingerprint (polled every 250 ms,
   two consecutive matches, up to 20 s).
5. Check what visitors receive:
   ```bash
   echo | openssl s_client -connect <ip>:443 -servername <host> 2>/dev/null | openssl x509 -noout -fingerprint -sha256 -subject -dates
   ```
   The fingerprint must equal the one in the certificate's details («Impronta SHA-256»).

If the host already has a Let's Encrypt certificate with **the same names**, Traefik would choose between the two at random.
The customer's request then ends `failed` with `acme_certificate_conflict` and changes nothing. Only an administrator can
clear it, from the domain's TLS route with explicit confirmation:

```bash
# administrator session; mode manual + evictAcme + the hostname typed again
POST /v1/admin/sites/<siteId>/domains/<domainId>/tls
{ "mode": "manual", "versionId": "<versionId>", "evictAcme": true, "confirmHostname": "<host>" }
```

This is the one case where the proxy restarts for a certificate (a few seconds, `hp_ingress_proxy` only): it is stopped, `acme.json`
is copied to `/var/lib/hosting-panel/ingress/acme/<store>.hp-evict-<date>.bak` (0600, the last 5 are kept), only the entries
for the assigned hosts are removed, the proxy starts and the fingerprint is verified. If the start fails the copy is restored
(`start_failed_restored`). At most one such cleanup per server every 15 minutes; it is audited. A certificate with more names
than the Let's Encrypt one (a superset of SANs) wins on its own and needs no cleanup.

Refusals you may meet: `manual_overlap` (another imported certificate has the same key for that host),
`captures_host` (the certificate would also become the winner for another hostname on this server that does not use it,
including the panel's own hostname), the per-organisation or per-certificate caps (`QUOTA_EXCEEDED`). Another organisation's hostname is
always refused.

## 2. Replace a certificate that is about to expire without losing HTTPS, and verify the live fingerprint

1. Warnings: the administrator's health page shows imported certificates expiring within 14 days (warning) and 7 days or
   expired (critical); the certificate pages also show the 30-day tier. Audit events `site.tls_certificate.expiring` and
   `.expired` are written once per version and tier.
2. In **Domini** choose «Sostituisci questo certificato…» (or the administrator's inventory) and import the renewed PEM as a
   **new version** of the same certificate. Versions are immutable.
3. Activating the new version moves every domain of the same organisation that used an older version of that certificate,
   across all the organisation's sites, in one operation (permission checked per site, one audit event per site). If another
   affected site has an active operation the request is refused with `409 RESOURCE_LOCKED`: retry later.
4. HTTPS is never interrupted: the proxy reloads a swapped manifest without restart. With the same acceptance script a
   rotation under load produced 4086 handshakes and 0 errors on one proxy process.
5. Verify the live fingerprint:
   ```bash
   echo | openssl s_client -connect <ip>:443 -servername <host> 2>/dev/null | openssl x509 -noout -fingerprint -sha256 -enddate
   ```
   It must equal the fingerprint of the new version. The old version becomes `inactive`; delete it only when no domain uses
   it (`409 CERTIFICATE_IN_USE` otherwise).

An expired imported certificate keeps being served (browsers warn): the panel never falls back silently to Let's Encrypt or to
HTTP.

## 3. Return to Let's Encrypt, handle DNS that is not ready, and a previous certificate left in the ACME store

1. In **Domini** choose the origin «Let's Encrypt (automatico)» and confirm. The routes get the ACME resolver first, then the
   proxy is reloaded without the imported version, and the panel checks that the removed fingerprint is no longer served.
2. If the ACME store (`/var/lib/hosting-panel/ingress/acme/acme.json`) has no entry for the host, Traefik orders a certificate
   at the reload and, until it is issued, visitors see Traefik's default certificate (2.5 s with the Pebble test CA; seconds
   with Let's Encrypt). The page says so.
3. DNS not ready: the order fails like any ACME order. Check the A record points to `<ip>` and that **no AAAA record exists**,
   then use «Controlla ora». The retry waits grow 15 min, 1 h, 3 h, 6 h, 24 h (24 h after a Let's Encrypt rate limit).
   Alternatively choose DNS-01 for that domain (ADR 0030) if a DNS provider is configured.
4. A previous Let's Encrypt certificate still in the store is reused when the manual one is removed; nothing edits
   `acme.json` while the proxy runs (the only edit is the administrator's cold cleanup of procedure 1, with a backup).
5. Refused: returning a host to Let's Encrypt (or adding a new ACME sibling) while another loaded imported **wildcard**
   still covers it, because Traefik would keep serving the wildcard (`captures_host`). Assign the new domain directly to the
   wildcard's version (domain creation accepts `tlsVersionId`) or remove the wildcard first.

## 4. Recover TLS after an update, a reboot, a corrupted manifest or a missing key file, without activating another domain's certificate

What persists: `/var/lib/hosting-panel/ingress/dynamic/manual-certs/<versionId>/{fullchain,privkey}.pem` (directory 0700,
files 0400, owner `hp-executor`), the top-level manifest `/var/lib/hosting-panel/ingress/dynamic/hp-manual-certificates.yml`
(file references only, no PEM) and `/var/lib/hosting-panel/ingress/manual-tls-state.json` (generation, last verified set).
The proxy keeps serving with the API and the database down, and `hp-update` never recreates the proxy.

1. After `hp-update` or a reboot nothing needs doing: the executor regenerates the manifest from its inventory at start, and
   the API reads the executor's inventory, re-sends any missing version (the key is decrypted from the database and travels
   only on the signed IPC) and publishes with a compare-and-swap on the generation. A converge tick runs every 60 s and once
   at start.
2. Check the services and the files:
   ```bash
   sudo systemctl status hp-docker-executor hp-api
   sudo ls -l /var/lib/hosting-panel/ingress/dynamic/ /var/lib/hosting-panel/ingress/dynamic/manual-certs/
   ```
3. A manifest or a key file that is corrupted or missing only drops **that** certificate: its hosts receive Traefik's default
   certificate, the routes stay, other hosts are unaffected. Restart the two services; the API re-sends the missing
   versions from the database at its next converge tick (at most 60 s after start):
   ```bash
   sudo systemctl restart hp-docker-executor && sudo systemctl restart hp-api
   ```
4. Do not edit or delete `hp-manual-certificates.yml` or `manual-tls-state.json` by hand, and never put `.yml`, `.yaml`,
   `.toml` or `.tmpl` files under `manual-certs/` (Traefik would load them).
5. Safety: the executor refuses to publish a certificate that would win for a hostname not assigned to it (`captures_host`),
   so a recovery never promotes the certificate of another domain. After a panel restore (`hp-restore-panel`), versions that
   were `applying` become `failed` (`interrupted`), the confirmed generation is reset and the files are re-created from the
   database at the next API start; activate the failed assignment again if needed.
6. A reboot of the host has **not** been proven on a real VM in this release (acceptance row TLS-10 is pending the owner);
   proxy container restarts (5/5) and executor/API restarts were proven on a local Docker Engine.

## 5. Configure S3 and local destinations, mount a dedicated volume, verify the filesystem and the free space

1. **S3**: **Amministrazione › Backup › Destinazioni**: endpoint, region, bucket, prefix and keys; use «Prova» (the secret is
   write-only). Changing endpoint, bucket or prefix creates a new destination and archives the current one; its backups stay
   restorable and nothing is deleted from the bucket.
2. **Local folder on the server**: the root is fixed by the executor (`HP_BACKUP_LOCAL_ROOT`, default
   `/var/lib/hosting-panel/local-repos`, created `2770 hp-executor:hp-executor` (setgid) by the bootstrap and by `hp-update`). Neither
   the API nor a customer ever supplies a path. Only one local destination exists. The executor runs with
   `RestrictSUIDSGID=yes`, so it can never ask for the setgid bit: every folder it creates under the root (`<targetId>`,
   `sites/`, `sites/<siteId>`, `panel/`) is made `0770` and inherits setgid and the group from its parent. A root or a
   volume without `2770 hp-executor:hp-executor` is refused with `local_target_unsafe`.
3. **Dedicated disk** (recommended: a local copy shares the disk's fate with the server). Mount it, then add a drop-in:
   ```bash
   sudo mkdir -p /srv/hp-backups
   sudo mount /dev/<device> /srv/hp-backups        # and add it to /etc/fstab
   sudo chown hp-executor:hp-executor /srv/hp-backups && sudo chmod 2770 /srv/hp-backups
   sudo mkdir -p /etc/systemd/system/hp-docker-executor.service.d
   sudo tee /etc/systemd/system/hp-docker-executor.service.d/local-backups.conf >/dev/null <<'EOF'
   [Service]
   Environment=HP_BACKUP_LOCAL_ROOT=/srv/hp-backups
   ReadWritePaths=-/srv/hp-backups
   EOF
   sudo systemctl daemon-reload && sudo systemctl restart hp-docker-executor
   ```
   Run the `chown`/`chmod` as root on the **mounted** volume (the mode lives on the volume's own root, not on the empty
   mountpoint). The same applies to a volume mounted at `<root>/<targetId>` instead of at the root: `chown
   hp-executor:hp-executor` and `chmod 2770` it after mounting, otherwise `sites/` and `panel/` are not created and Inizializza
   answers `local_target_unsafe`. The executor never runs `chmod` on these folders.
   The `-` before the path lets the executor start even if the disk is absent. Do **not** add `RequiresMountsFor=`: the safety
   is the per-destination marker, below. The path must be absolute, at least two levels deep, characters
   `A-Za-z0-9._@+/-` only, and not under `/etc`, `/proc`, `/sys`, `/dev`, `/run`, `/boot`, `/root` or `/var/lib/docker`;
   otherwise local destinations are disabled (`local_target_unsafe`) and S3 is unaffected.
4. In **Destinazioni** choose «Aggiungi destinazione locale», then **Inizializza**. This writes the marker
   `<root>/<targetId>/.hp-local-target` (the only action that ever creates `<root>/<targetId>`), then the folders `sites/`
   and `panel/` (both inherit `2770`). A backup never creates the folder: with the disk unmounted the job fails closed with
   `local_target_unmounted` instead of writing to the system disk. After mounting a **different** disk, initialise again.
5. Verify: «Prova» runs the guard (marker, ownership, write probe, free space) and shows free space of total; the destination
   needs at least 1 GiB free plus the job's estimate for writing jobs (64 MiB margin for restore, archive and forget). The
   administrator's alert `backup_target_space_low` shows when space runs out. From a shell:
   ```bash
   findmnt /srv/hp-backups; df -h /srv/hp-backups; sudo cat /srv/hp-backups/<targetId>/.hp-local-target
   ```
   Repositories contain only ciphertext (restic, key `/etc/hosting-panel/backup.key`).
6. **Same-server warning** (shown in the interface): *«I backup locali sullo stesso server non proteggono dalla perdita del
   server o del disco. Per disaster recovery conserva una copia fuori dal server e la chiave di recupero.»* Keep one copy off
   the server.
7. Two destinations: in **Regole** choose up to two destinations for the site backups and for the panel copy; the
   customer sees «Copia esterna» / «Copia su questo server» and, with two, «Entrambe». Copies run one after the other.

## 6. Keep `backup.key` in external custody; recover an S3 or local backup on a new host

1. Copy `/etc/hosting-panel/backup.key` off the server **now** (password manager, offline media). All backups of every
   destination (S3 and local, sites and panel) are encrypted with this single key: without it nothing can be read. It is
   created once by the bootstrap and never overwritten by updates; there is no rotation in this release.
   ```bash
   sudo install -m 0600 /etc/hosting-panel/backup.key /root/backup.key.copy   # then move it OFF the server
   ```
2. On the new server: switch the old one off; run `install.sh` (same release or newer); put the key back:
   ```bash
   sudo install -m 0440 -o root -g hp-executor backup.key /etc/hosting-panel/backup.key
   ```
3. **From S3** (keys are asked interactively, or taken from `HP_S3_ACCESS_KEY_ID` / `HP_S3_SECRET_ACCESS_KEY`; never pass them
   as arguments):
   ```bash
   sudo hp-restore-panel --endpoint https://s3.example.com --region us-east-1 --bucket <bucket> --prefix <path>
   ```
4. **From a local destination** (only possible if the old disk was saved and mounted on the new server, in the same managed
   folder): mount it, then point at the panel repository `<root>/<targetId>/panel`:
   ```bash
   sudo hp-restore-panel --local-repo /srv/hp-backups/<targetId>/panel
   ```
   `--local-repo` cannot be combined with `--endpoint`, `--region`, `--bucket` or `--prefix`, never asks for S3 keys, reads the
   disk read-only (no lock, no network) and accepts only a canonical absolute path with no symlink, not owned by root, not
   world-writable.
5. Exit codes: `0` restored, `1` a step failed (safe to run again), `2` refused (bad arguments, not root, `backup.key` missing,
   sites already present, applications already present, copy from a newer panel, question not answered `y`), `7` local
   destination not mounted, `8` local folder unsafe (only with `--local-repo`).
6. Then sign in with the old administrator account, point the domains to the new server, and use **Ripristina** on each site.
   The panel copy is the one of the last night: later changes are lost. If the disk was lost together with the server, a
   local-only copy is lost too, which is why an off-server copy is required.

## 7. Restore a `partial` copy using only the destination that succeeded

A backup is `partial` when it was written to one destination and failed on the other (the badge shows a warning triangle and
the word «Parziale»; the administrator gets the alert `backup_partial`; the audit event is `site.backups.partial`). The site is
protected only by the successful copy until a new backup succeeds on both.

1. In the site's **Backup** tab open the backup: each copy shows its destination and status («Dove è conservato»).
2. **Ripristina** asks «Ripristina da»: choose the copy with status «Riuscita». The dialog always names the source. The copy
   that failed is not offered.
3. Confirm by typing the site name. The restore reads that copy only; the failed destination is not contacted.
4. In parallel, fix the cause on the failed destination (procedure 9) and run **Fai un backup adesso** to get two good copies
   again. Retention works per destination: it prunes each destination's own snapshots.
5. A backup taken before a WordPress update or import (`pre_update`) must succeed on every destination of the policy: with only
   one good copy the operation fails with `INTERNAL_ERROR`, the good copy is kept and the site is not touched. The panel
   backup uses one dump for both copies; if the second copy fails the operation is reported failed and the first copy stays.

## 8. Download a plain ZIP and tell the customer what it contains (`.zip.age` is not available)

1. In the site's **Backup** tab choose «Prepara il download» for a succeeded or partial backup; with two copies you may name
   the copy to read. One download per site exists at a time; it is kept 60 minutes in `/var/lib/hosting-panel/backups`
   (`0700`) with `Cache-Control: no-store`, then deleted.
2. The ZIP is **not encrypted**: it holds all the site's files and its database dumps, including database passwords. Tell the
   customer to store it safely and not share it (the page says so).
3. `.zip.age` (encrypted with an `age` public key) is **not** available: `encryptedBackupExportAvailable: false`, the API
   answers `422 NOT_SUPPORTED` to `format: "zip.age"`, and the interface does not offer it. It needs an approved, digest-pinned
   `age` tool (BLOCKED #4, ADR 0032 §2.11). When it ships, the customer must know that losing the age private key makes the
   exported file unusable: the panel never stores it and there is no passphrase.
4. Verify a plain download offline: `unzip -t site.zip`.

## 9. Identify and fix an unmounted destination, a full disk, a corrupted repository and expired S3 credentials

Find the failing destination first: **Amministrazione › Backup › Destinazioni** (last test outcome and problem), the health
page alerts (`backup_target_space_low`, `backup_site_without_target`, `backup_partial`) and the failed backup's problem code.

| Problem code | Meaning | What to do |
| --- | --- | --- |
| `local_target_unmounted` | folder missing or marker absent: disk not mounted | `findmnt <root>`; mount the disk, then «Prova». If it is a new disk, «Inizializza» again |
| `local_target_readonly` | filesystem is read-only | `dmesg \| tail`; remount read-write (`mount -o remount,rw <root>`), fsck if needed, «Prova» |
| `local_target_unsafe` | root or folder with wrong owner/mode, symlink, or invalid `HP_BACKUP_LOCAL_ROOT` | as root run `chown hp-executor:hp-executor <root>` and `chmod 2770 <root>` (also on a volume mounted at `<root>/<targetId>`); repository folders must be `2770` with group `hp-executor`; a leftover folder with a wrong mode must be corrected or removed; or fix the drop-in; restart `hp-docker-executor` |
| `no_space` | disk full | free space or enlarge the volume (`df -h <root>`); the 1 GiB floor and the alert warn earlier; no quotas exist |
| `backup_copy_missing` | the copy is no longer where it was saved | restore from the other copy (procedure 7); the missing copy stays recorded |
| `auth_failed` / `unreachable` (S3) | credentials expired or endpoint unreachable | rotate the keys at the provider, edit the destination (the secret field is write-only), «Prova» |
| `wrong_key` / `key_file_missing` | `/etc/hosting-panel/backup.key` is not the key of the repository, or is missing | put the right key back (`0440 root:hp-executor`); never create a new one over an existing repository |
| `repository_locked` | another job holds the repository | wait for it; the next run retries (`journalctl -u hp-docker-executor`) |
| `other` (repository corrupted) | restic cannot read the repository; there is no dedicated code and no repair tool in the panel | read the executor journal; do not delete the repository by hand. If it cannot be repaired, archive the destination (its readable copies stay restorable) and add a new one; this path was not exercised in acceptance |

Every refusal leaves the previous state intact: a failed backup never deletes older copies. Service logs:
`journalctl -u hp-docker-executor -u hp-api --since "1 hour ago"`.

## 10. Update and, if possible, roll back without breaking history; limits of older releases

1. Update: `sudo hp-update` (or `--version <v>` / `--archive <file>`). Run `sudo hp-update --dry-run` first to see the plan.
   Migrations 0021, 0022 and 0024 (site templates) are additive: no column is dropped or retyped and every new column is nullable or has a default.
   The proxy is **not** recreated; nothing for TLS needs doing, and the executor unit gains one `Environment=` line and the
   bootstrap one directory (plus `/var/lib/hosting-panel/site-php` for the per-site PHP settings of ADR 0033).
2. **Automatic rollback** (health window 90 s) stays unconditional: it happens before any data of the new features can exist.
   The older release keeps working because the new code still writes `site_backups.snapshot_id` and `size_bytes` for the
   primary copy.
3. **Downgrade chosen by the operator** (`hp-update --version <older> --allow-downgrade`): `hp-update` refuses with **exit
   code 8** when the target release does not list the feature in its `RELEASE.json` (`features`: `manual-tls`,
   `backup-targets`, `site-templates`) and the database already uses it: a domain with `cert_mode = 'manual'`, a backup
   destination that is not the legacy S3 one and not archived, or a site whose `template_version_id` is neither empty nor the
   built-in WordPress version `stv_wordpress_1` (ADR 0033: a site on a custom template or on a newer version of the built-in
   one; sites created before migration 0024 and sites on built-in version 1 do not count). A `psql` error also counts as a
   refusal (fail closed). To go back without forcing: return the domains to Let's Encrypt, archive the non-legacy
   destinations (archived destinations keep their copies on disk) and delete those sites or re-create them on built-in
   WordPress version 1 (a site can only move to a newer version of its own template, never to another template or back);
   or keep the current release. To go ahead knowingly:
   ```bash
   sudo hp-update --version <older> --allow-downgrade --allow-feature-loss
   ```
   Application stacks add the feature `app-stacks`; see `docs/runbooks/application-stacks.md` §4.
4. What the older release cannot do after a forced downgrade: it keeps running sites that use a custom site type with their
   stored configuration but does not know the site types (no template list, no version change, and a PHP change builds the
   built-in image); it still serves imported certificates (the files and the manifest
   stay) but cannot rotate or remove them; it does not see local copies; and its change of S3 endpoint empties
   `site_backups` again. Local repositories and snapshots are untouched on disk.
5. Panel copies written by an older release are re-attached on the next API start (boot repair).
6. Exit codes of `hp-update` otherwise: `0` updated, `1` generic error, `2` downgrade refused or bad arguments, `4` checksum,
   `6` rolled back, `7` rollback failed, `8` downgrade refused because it would lose a feature in use.
