# Step 1b — Live Installation Acceptance Report

**Latest run:** a focused SSH, IPC and ingress-health re-test on 2026-11-08 at `250c891` (`live-ssh-retest-report.md`). It came after the full re-test at `e5935f6` (`live-retest-report.md`). The release was `hosting-panel-0.2.0-linux-x64.tar.gz` with Node 26.13.0, Traefik v3.7, Docker CE 29.9.3 and PostgreSQL 18.6 PGDG. The first run (@ `bc1b9d9`, `live-test-report.md`) was not accepted.

**Test bed:** disposable privileged systemd containers acting as VMs on a workstation with Docker 29.9.3 and cgroup v2.

- The full checklist ran on Ubuntu 26.04 and Debian 13.
- Ubuntu 24.04 and Debian 12 got install, health and login only.
- The SSH residual case ran on Ubuntu 26.04 and 24.04.
- Each container had named volumes for `/var/lib/docker` and `/var/lib/containerd`. There was no public IP or DNS.

## Verdict: accepted, no open residual risk from the live tests

- On all four OSes, a fresh install as shipped completes without any workaround. It exits 0 in 48–59 s cold and runs all 12 steps.
- The six units are active and the IPC sockets work. The ingress proxy is running before the installer reports healthy.

All blockers from the first run are confirmed fixed live:

- **libatomic1** is now installed as a prerequisite.
- **Entry points behind the `current` symlink now run.** `hp-accounts unlock` prints `{"ok":true}`, `hp-break-glass` prints its usage, the admin is created, and host-agent and executor stay up.
- **The socket directory is `3770 root:hp-ipc`** (setgid and sticky). It stays that way across an install rerun, `hp-update`, a rollback and a restart of the daemons. Each daemon replaces its own stale socket, but neither can unlink the other's (`Operation not permitted`).
- **The health check covers all four units and catches a crash loop.** A sabotaged update rolled back with exit 6 in about 10 s, where the first run took 90 s.

Residuals from the `e5935f6` re-test, now fixed and verified live at `250c891`:

- **R-SSH (Medium) is fixed.** The SSH preflight now reads ports from the first live source: the `sshd` listeners in `ss`, else the `Listen=` entries of an active `ssh.socket`, else `sshd -T`.
  - Take an `sshd_config` that says Port 22 while an `ssh.socket` drop-in listens only on 2222. That now exits 7 at step 1 with no change on Ubuntu 26.04 and 24.04: no packages, no nftables, no `/opt/hosting-panel`. This holds both with and without a running `sshd` process.
  - `Port 2222` (on `ssh.service`) and `ListenAddress 0.0.0.0:2222` still exit 7 with no change.
  - A normal host on 22 passes.
- **O1 (Low) is fixed.** Step 12 now waits for `hp_ingress_proxy`. On a cold host the proxy started 2.4 s before `All panel services (…, ingress proxy) are healthy`.
- **O2 (Cosmetic) is fixed.** `hp-update` now prints `All panel services are healthy`.

## What was verified (re-test, no product workarounds)

- **Panel over HTTPS:** the panel answers on `https://<ip>` and `https://<hostname>` through Traefik with the self-signed default certificate, and HTTP redirects to HTTPS. The proxy runs as the non-root hp-executor UID.
- **Firewall:** the nftables table allows 22, 80 and 443, plus 3000 only from docker0 and `br-*`. Seen from another host on the bridge, 3000, 4000 and 5432 are filtered and 443 is open.
- **Secrets:** env files are `0400 root`, keys are `0400 hp-api` or `0440 hp-ipc`, and nothing is world-readable.
- **Admin login:** works end to end through the BFF with the step-11 password plus TOTP. A wrong password is rejected.
- **Customer flow:** the admin creates a customer account through the BFF. The customer logs in with the temporary password (`mustChangePassword:true`) and changes it (204). The old password is then rejected and the new one works (`mustChangePassword:false`).
- **Install rerun:** exits 0 in about 10 s. `/etc/hosting-panel/*` checksums are unchanged, there is one admin, the proxy is not restarted, and all units stay active.
- **Update 0.2.0 → 0.2.1:** "updated" in 7–8 s, with step 8 printing `All panel services are healthy`. A curl loop saw one 502 in 120 samples, and the proxy was not restarted.
- **Mislabelled archive:** an archive named 0.3.0 containing 0.2.0 exits 2 at step 2, and `current` and `/opt` are untouched.
- **SSH preflight:** sshd on 2222 gives exit 7 at step 1 with no change to packages, files or nftables. This holds whether 2222 comes from `Port`, from `ListenAddress` or from an `ssh.socket` `ListenStream` override.
- **Repo availability:** the Docker CE and PGDG repos have packages for resolute, trixie, noble and bookworm.

## Environment note

Nested Docker 29 needs `/var/lib/containerd` off the overlay rootfs. A second named volume solves this in the harness. This is not a product issue.

## Still to verify on a real VM

- Let's Encrypt (staging, then production) once DNS points at the server. Use a real ACME contact email, because Let's Encrypt rejects `example.com`.
- An external port scan and IPv6.
- The exit-3 path (a Docker or PGDG package missing for the codename).
