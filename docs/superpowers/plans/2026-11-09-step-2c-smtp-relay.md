# Step 2c — Outgoing Mail Relay for WordPress Sites — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note:** this is the "Step 2c" outline from the 2a plan. Reading the code changed the outline in three places, each marked **(builder's call)**:
- **Port 587, not 25.** The relay image submits on 587, so sites talk to `hp-mail:587`. The image's `master.cf` also keeps `smtp inet` on 25 open inside the container. Both stay unpublished, so neither port leaves the server.
- **The relay password is not a `*_FILE` secret like site secrets.** A file bind of a tmpfs file breaks after a reboot, because Docker recreates a missing bind source as a directory. The relay instead binds a tmpfs **directory** that `systemd-tmpfiles` recreates empty at boot. The relay therefore always starts and queues mail, even before the API has written the password back (Task 3).
- **`siteMail` lives in the site's revision config, so it is part of `specHash`.** That keeps drift consistent. Existing sites get it through a new revision and the existing `service.deploy` path (Task 6), just as a PHP-version change does.
  - A `specHash` change alone would **not** redeploy anything: `DriftReconcilerService` is observe-only (`drift-reconciler.service.ts:84`).
  - A derived hash that is not stored on the revision would mark every new container as drifted (`hosting-domain/src/drift.ts:74`).

Nothing here depends on a real mail provider except the last task.

**Open questions for the owner** are at the end. The plan builds the recommended answer to each one. Every question says which tasks change if the owner picks the other answer.

**Earlier owner decisions that bind this plan:**
- Only WordPress sites. One customer per server, and fresh installs only.
- IT and EN, with Italian as the default. The customer console uses no technical jargon, and every error says what to do next.
- `CP-01`: sites keep serving while the control plane is down.
- Live acceptance runs on the owner's real VM.

**Goal:**
- The server administrator enters one outgoing SMTP relay: host, port, user name, password and sender domain. They can send a test email and see recent send failures.
- Every WordPress site sends mail through it with no setup by the customer. `wp_mail` works, and so does plain PHP `mail()`.
- Mail is queued on the server, so a slow or briefly unreachable provider never loses a booking confirmation.
- The customer sees one plain sentence about how their site's email is sent.

**Architecture:**
- **A platform relay container, `hp_mail_relay`**, built like `hp_mariadb`:
  - It runs Postfix (`boky/postfix`) and is created by `hp-docker-executor`.
  - Its home network is `hp_mail_net`, a normal (non-internal) bridge, so it can reach the provider.
  - It joins every site internal network under the alias `hp-mail`.
  - It publishes no host port, so only containers on those networks, and the host itself, can reach it.
  - Postfix forwards every message to `[host]:port` with SASL authentication over **verified TLS** (`smtp_tls_security_level=secure`; open question 6).
  - The queue lives on the named volume `hp_mail_relay_spool`, so queued mail survives container recreation and reboots.
- **Sites need no secret and no setting.** On every WordPress container the executor adds three read-only file binds, from `/var/lib/hosting-panel/site-mail/`:
  1. **A must-use plugin** that, **as a default**, points PHPMailer at `hp-mail:587`;
  2. **A `php.ini` drop-in** that sets `sendmail_path` to a bundled PHP sendmail shim (the image has no `sendmail`);
  3. **The shim itself.**

  Site containers also sit on their edge network, which is `internal: false` (`docker-engine-adapter.ts:1310-1320`), so they do have internet access. A customer's own working SMTP plugin, which hooks later, therefore keeps winning (open question 5).

  The executor owns the file contents. The API only sets `siteMail: true` in the revision config.
- **Relay password:**
  - It is stored encrypted (AES-256-GCM, `ADR-015`) in a new single-row table `mail_relay_settings`, under the fixed AAD `platform:*:HP_MAIL_RELAY_PASSWORD`.
  - The API decrypts it only to send it over signed IPC to `applyMailRelay`.
  - The executor writes it as Postfix's `sasl_passwd` (mode `0444`) into `/run/hosting-panel/mail-relay/` (tmpfs). That directory is bound read-only into the relay.
  - It never appears in env, argv, labels, DTOs, audit or logs.
  - **The API applies the settings asynchronously.** It does so at boot, right after a save, and then every 60 s until the apply succeeds. After that it re-applies every 10 min, which is idempotent and cheap: an executor-only restart that changes the relay payload is then also reconciled.
- **`CP-01` (one accepted degradation, recorded in ADR 0018):**
  - With the control plane stopped, the relay keeps running and keeps delivering: the tmpfs file is still there.
  - After a **reboot** with the control plane down, the relay starts with an empty secret directory. It accepts and queues mail, but cannot authenticate, so it defers delivery.
  - When the API is back, the executor restarts the relay and flushes the queue (`postqueue -f` through the Engine exec API, with a fixed argv). Queued mail goes out within a minute, not after Postfix's backoff, which can reach about 67 min.
  - Websites keep serving throughout.
- **Sender policy (open question 1, recommended answer built):**
  - Postfix rewrites the envelope **and** header sender of every message to `noreply@<sender domain>`, and keeps the display name.
  - The header rewrite needs `local_header_rewrite_clients=permit_mynetworks`, because site containers are "remote" clients to Postfix.
  - The must-use plugin keeps the site's original sender as `Reply-To` when none is set.
- **Failures and test email:**
  - The executor reads the relay's log (`docker logs`) and parses Postfix `status=sent|deferred|bounced` lines. Only the time, recipient, status, a classified problem and a redacted reason (at most 300 chars) cross IPC.
  - The test email is submitted by the executor over plain SMTP to the relay's `hp_mail_net` address. The executor then follows that queue ID in the log for up to 20 s.
  - The BFF gives this one route a 45 s upstream timeout. The default is 8 s (`upstream.ts:46`) **(builder's call:** a per-route override is smaller than submit-then-poll**)**.

**Tech Stack:** the existing monorepo (NestJS and Fastify, Next.js 16, Drizzle, Vitest, Docker Engine API). **No new npm dependency:** SMTP submission is about 80 lines on `node:net`. Pinned facts, each checked on 2026-11-09:

| Fact | Value | Source |
|---|---|---|
| Relay image | `boky/postfix:5.2.1-alpine` (pushed 2026-11-02). Alpine rather than the default Debian, to shorten the first pull on a 2 GB server **(builder's call)**. | Docker Hub tags API `boky/postfix` |
| Why this image | Maintained (`edge` rebuilt 2026-11-04). It is a relay-only Postfix configured entirely by env: `RELAYHOST`, `POSTFIX_<main.cf key>` applied after its own setup, `ALLOW_EMPTY_SENDER_DOMAINS`, `LOG_FORMAT=plain`. It sets `smtp_tls_CAfile` to the system bundle whenever `RELAYHOST` is set, and leaves `smtp_sasl_*` alone when `RELAYHOST_USERNAME` is unset. An **empty** `POSTFIX_<key>` deletes the key. Rejected: msmtpd and similar have **no queue**; building our own image needs a registry the project does not have. | `bokysan/docker-postfix` README, Dockerfile, `scripts/functions.sh` |
| Image layout | `EXPOSE 587`; `master.cf` also has `smtp inet` on 25; `USER root` (the master drops to `postfix`); `ENTRYPOINT ["/tini","--"]`; `VOLUME` includes `/var/spool/postfix`, `/var/lib/postfix` and `/etc/postfix`; `smtp` is not chrooted | Dockerfile and `master.cf` at `master` |
| Postfix rules this plan depends on | Header rewriting is skipped for remote clients unless `local_header_rewrite_clients` matches them. `smtpd_client_event_limit_exceptions` defaults to `$mynetworks`, which would exempt every site from the rate limit. A SASL failure soft-bounces by default (`smtp_sasl_auth_soft_bounce=yes`). The backoff runs from 300 s to 4000 s. Queue lifetime is 5 d. | `postconf(5)` |
| Harness upstream | `axllent/mailpit:v1.33.1` (2026-11-07), with `--smtp-auth-file`, a test TLS cert and `--smtp-require-starttls` | Docker Hub tags API `axllent/mailpit` |

**Spec:** `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`, mainly:
- §3.10 (all of it);
- §3.2 (plain errors with a next step, no jargon);
- §5 (password recovery by email, see open question 3);
- §6 (non-goals: no mailboxes, no receiving);
- §7 (IT and EN for every message and error);
- §8 step 2;
- §9 (`CP-01`, no secrets in env, logs or DTOs, the Docker socket only in the executor).

It builds on the 2a and 2b plans, ADRs 0015–0017, and `docs/security/step-2b-acceptance-report.md` (the harness).

## Global Constraints

- **Inherited rules.** Everything in the 2a and 2b Global Constraints still holds: hardening, the timeout budget, the jargon list (`apps/web/test/ui-copy.test.ts`), and IT/EN with Italian as the default.
- **The relay password never appears in:**
  - env, argv, container labels or the config hash;
  - DTOs, audit details or the outbox;
  - IPC error bodies;
  - API, executor or BFF logs.

  It exists in plaintext only in API memory during an apply, in the signed IPC body, and in the `0444` tmpfs file `/run/hosting-panel/mail-relay/sasl_passwd`.
- **Field validation, at both ends.** The API checks every field with the contracts schema. The executor checks again with the IPC wire schema, because the values end up in a Postfix map line.
  - **password:** 1–256 chars, no CR, LF or NUL, no leading or trailing whitespace;
  - **username:** 1–256 chars, no whitespace and no `:`;
  - **host:** a normalized **hostname** (`normalizeSiteDomain(h) === h`). An IP address is refused, because verified TLS needs a name the certificate can match (open question 6);
  - **port:** one of `25, 465, 587, 2525`;
  - **sender domain:** `SiteDomainSchema`.
- **Upstream TLS is verified:** `smtp_tls_security_level=secure` (with `smtp_tls_wrappermode=yes` on 465), against the image's system CA bundle. The password is never sent in clear or to an unauthenticated server.
- **Fixed limits (open question 8):**
  - 200 messages per hour per sending container (`smtpd_client_message_rate_limit=200`, `anvil_rate_time_unit=3600s`, `smtpd_client_event_limit_exceptions=127.0.0.0/8`, so site addresses are **not** exempt);
  - 100 recipients per message;
  - 25 MiB per message.
- **`CP-01`:**
  - `hp_mail_relay` has `RestartPolicy unless-stopped`. It is recreated **only** when its config hash label changes, and restarted (then flushed) only when the `sasl_passwd` content changes.
  - Its binds are the tmpfs directory and a named volume, never a tmpfs file.
  - Site containers' mail binds live under `/var/lib/hosting-panel/site-mail` (persistent). Those files are rewritten **in place**, never by rename (a single-file bind pins the inode), and explicitly `chmod 0644`, because the executor runs with `UMask=0007`.
  - `hp-update` never touches the relay. The executor never removes `hp_mail_relay_spool`.
- **Executor trust boundary:**
  - The API never names an image, mount, network, Postfix key or exec command. It sends `siteMail: boolean` on a spec, and `MailRelayApplyRequest | null`.
  - The only exec is the fixed `["postqueue", "-f"]`.
  - `detectOutOfBandContainerModification` accepts exactly the three `siteMailBinds(dir)` strings and nothing else outside the existing volume and secret rules.
- **Copy:**
  - Every new message and error exists in IT and EN, admin ones included.
  - Errors are mapped from the code through `errorMessage(m, code)` (`i18n/index.ts:27`), never shown as the API's English text.
  - Customer copy allows "email", "sender" and "server administrator". It bans "relay", "SMTP", "Postfix", "SPF" and "DKIM", plus the existing list.
- **Admin errors also name a next step.**
- **Version:** root `package.json` → `0.5.0`. Migration `0007` is additive.
- **Every task ends green** on `corepack pnpm run build && corepack pnpm run lint && corepack pnpm run typecheck && corepack pnpm run test`. After editing `packages/*`, run `build` before app tests.

## Review Focus

1. **The host reboots while every panel unit is stopped, and a guest books a room.** Expected:
   - the site serves and `wp_mail` returns true;
   - the message is queued;
   - within 60 s of `hp-api` starting, the relay restarts once, is flushed, and the message is delivered once.

   Tests:
   - Task 3 `relay binds only a tmpfs directory and a named volume, never a tmpfs file`, `apply restarts and flushes the relay only when the password file changes`;
   - Task 6 `boot applies stored settings and retries until the executor answers`;
   - live in Task 9 step 6 and Task 10 step 5.
2. **Sites deployed before 0.5.0, and every new site container.** Expected:
   - every running pre-0.5.0 site is redeployed once, automatically, with the three mail binds, and never again;
   - new containers carry the binds;
   - the drift check does not flag them, and still flags any other host bind;
   - `siteMail` survives the real IPC deploy path.

   Tests:
   - Task 6 `a pre-0.5.0 site is upgraded once with a new revision and a deploy`;
   - Task 2 `mail binds are not drift, a fourth host bind is`, and `deploy over signed IPC keeps siteMail and adds the binds`;
   - live in Task 9 step 3 and Task 10 step 3.
3. **Hostile or hacked site code.** It may connect to `hp-mail:587` directly with a forged `From: ceo@bank.example`, inject headers, or send 10,000 messages. Expected:
   - **both** the envelope sender and the `From:` header are rewritten;
   - the executor's SMTP client refuses CR or LF;
   - the 201st message in an hour gets a 4xx;
   - the relay is unreachable from outside the server.

   Each property is pinned to the Postfix key that gives it:
   - Task 3 `relay env enforces the header rewrite for site clients` (`local_header_rewrite_clients=permit_mynetworks`) and `site clients are not exempt from the rate limit` (`smtpd_client_event_limit_exceptions=127.0.0.0/8`, not empty);
   - Task 4 `submitLocalMail refuses CR or LF in an address`;
   - the behaviour itself is proven live in Task 9 step 4.
4. **The administrator's password contains `:`, `#`, `$`, quotes, inner spaces or non-ASCII characters.** Expected:
   - it round-trips to Postfix unchanged;
   - a newline is refused;
   - a canary password never appears in a DTO, an audit row, a label, an env line, an IPC error body or a log.

   Tests:
   - Task 0 `password rules accept punctuation and inner spaces but not newlines or edge whitespace`;
   - Task 1 `settings round-trip through encryption and the row holds no plaintext`;
   - Task 3 `sasl line keeps the password verbatim and the payload never contains it`;
   - Task 5 `a failed apply never leaks the password in the IPC error or on the console`;
   - Task 6 `the password never leaves the API in a response or an audit row`.
5. **The provider rejects the login, is unreachable, has a bad certificate, or the cloud host blocks outbound 587.** Expected:
   - "Send test email" answers through the real BFF within about 30 s, with a classified problem and its next step in the admin's language;
   - the mail stays queued.

   Tests:
   - Task 4 `parsePostfixDeliveries classifies auth, connect, TLS and bounce lines`;
   - Task 6 `test email outcome maps to the admin result`;
   - Task 7 `test email route allows 45 s upstream` and `mail errors exist in IT and EN`;
   - live in Task 9 step 5.

---

## File map

| Area | Files |
|---|---|
| Contracts | `packages/contracts/src/mail-relay.ts` (new), `site-domains.ts` (`SiteDomainsDtoSchema.mail`), `ipc-schemas.ts`, `errors.ts`, `index.ts` |
| Data model | `packages/database/migrations/0007_mail_relay.sql` (new), `src/schema.ts`, `src/mail-relay-repository.ts` (new), `src/index.ts` |
| Executor contracts | `packages/executor-contracts/src/port.ts`, `spec.ts`, `phase1-executor.ts`, `mail-relay.ts` (new, report types) |
| Executor | `apps/docker-executor/src/site-mail.ts` (new), `mail-relay.ts` (new), `mail-relay-status.ts` (new), `smtp-submit.ts` (new), `docker-engine-adapter.ts`, `server.ts`, `client.ts`, `simulator-adapter.ts`, `main.ts` |
| API | `apps/api/src/mail/mail-relay.service.ts` (new), `mail/site-mail-upgrade.ts` (new), `controllers/admin-mail-relay.controller.ts` (new), `runtime/service-spec.ts`, `sites/managed-sites.service.ts`, `sites/site-domains.service.ts`, `tokens.ts`, `app.module.ts`, `create-app.ts` |
| Web | `app/admin/mail/page.tsx` (new), `components/admin/mail-relay-form.tsx` (new), BFF `app/api/admin/mail-relay/route.ts` and `…/test/route.ts` (new), `lib/upstream.ts`, `lib/bff-proxy.ts`, `components/layout/sidebar-nav.tsx`, `components/customer/domains-panel.tsx`, `lib/server-api.ts`, `i18n/it.ts`, `i18n/en.ts` |
| Infra and docs | `infra/systemd/hosting-panel-tmpfiles.conf`, `infra/linux/bootstrap-dedicated.sh`, `.github/workflows/ci.yml` (`php --version`), `docs/architecture/adr/0018-outgoing-mail-relay.md` (new), `README.md`, `HARNESS.md`, `.agents/brain/state.md`, `docs/api/openapi.yaml`, `package.json` |

`infra/release/build-release.mjs` and `infra/linux/update.sh` need **no change**:
- the site-mail file contents are string constants in the executor's `dist`;
- the updater re-runs bootstrap (`update.sh:59-63,193`), which creates the new directories.

`install.sh` needs no new step, because the relay exists only once the administrator configures it.

---

### Task 0: Mail relay contracts and IPC wire schemas

**Files:**
- Create: `packages/contracts/src/mail-relay.ts`
- Modify:
  - `packages/contracts/src/site-domains.ts`;
  - `ipc-schemas.ts` (`ApprovedServiceSpecWireSchema.siteMail`, and the mail IPC schemas);
  - `errors.ts`: the new code `MAIL_RELAY_UNAVAILABLE` → 503 in `ERROR_CODES` and `ERROR_CODE_HTTP_STATUS`;
  - `index.ts`.
- Test: `packages/contracts/test/mail-relay.test.ts` (new)

**Interfaces (produces):**
- **Constants:**
  - `MAIL_RELAY_IMAGE = "boky/postfix:5.2.1-alpine"`;
  - `MAIL_RELAY_CONTAINER_NAME = "hp_mail_relay"`;
  - `MAIL_RELAY_ALIAS = "hp-mail"`;
  - `MAIL_RELAY_SMTP_PORT = 587`;
  - `MAIL_RELAY_PORTS = [25, 465, 587, 2525] as const`;
  - `MAIL_PROBLEMS = ["auth_failed", "unreachable", "tls_failed", "rejected", "credentials_missing", "other"] as const`, with `type MailProblem`.
- **Field schemas:** `MailRelayHostSchema` (lowercased and trimmed, then `normalizeSiteDomain`; IPs are refused, because `normalizeSiteDomain` already rejects them), `MailRelayUsernameSchema` and `MailRelayPasswordSchema`, as in Global Constraints. Each issue carries a stable `message` key (`host_invalid`, `username_invalid`, `password_invalid`, `password_required`) that the web maps to i18n. Messages never include the value.
- **Admin input:** `MailRelaySettingsInputSchema = z.object({ host, port: z.union(MAIL_RELAY_PORTS literals), username, password: MailRelayPasswordSchema.optional(), senderDomain: SiteDomainSchema })`. A missing `password` means "keep the stored one".
- **Admin DTOs:**
  - `MailFailureDtoSchema = z.object({ at: iso, recipient: z.string().max(254), status: z.enum(["deferred", "bounced"]), problem: z.enum(MAIL_PROBLEMS), detail: z.string().max(300) })`.
  - `MailRelaySettingsDtoSchema = z.object({ configured, host, port, username, senderDomain, passwordSet: z.boolean(), updatedAt, applied: z.boolean(), relayRunning: z.boolean().nullable(), sentLast24h: z.number().int().nullable(), failures: z.array(MailFailureDtoSchema) })`. The nullable fields are `null` when not configured.
    - `applied` means the stored settings were accepted by the executor since this API process started.
    - `relayRunning` is `null` when the executor did not answer.
  - `SendTestMailInputSchema = z.object({ to: z.string().email().max(254) })`.
  - `MailTestResultDtoSchema = z.object({ outcome: z.enum(["sent", "deferred", "bounced", "pending"]), problem: z.enum(MAIL_PROBLEMS).nullable(), detail: z.string().max(300).nullable() })`.
- **Customer view:** `SiteDomainsDtoSchema` gains `mail: z.object({ configured: z.boolean(), fromAddress: z.string().nullable() })`.
- **IPC (in `ipc-schemas.ts`):**
  - `MailRelayApplyRequestSchema = z.object({ host, port, username, password: MailRelayPasswordSchema, senderDomain })`. The password is required here.
  - `MailRelayApplyIpcRequestSchema = z.object({ config: MailRelayApplyRequestSchema.nullable() })`.
  - `MailRelayStatusIpcRequestSchema = z.object({ since: iso })`, and `MailRelayStatusReportWireSchema = z.object({ present, running, sentCount, failures: z.array(MailFailureDtoSchema).max(50) })`.
  - `MailTestIpcRequestSchema = z.object({ to: email, from: email })`, and the response is `MailTestResultDtoSchema`.
  - `ApprovedServiceSpecWireSchema` gains `siteMail: z.boolean().optional()`.

- [ ] **Step 1: Write the failing tests** in `mail-relay.test.ts`:
  - `password rules accept punctuation and inner spaces but not newlines or edge whitespace`:
    - accepted: `p:a#s$s"w'o rd`, `pässwörd€` and a 256-char value;
    - rejected: `a\nb`, `a\rb`, `a\0b`, ` lead`, `trail `, `""` and a 257-char value;
    - no issue message contains the input.
  - `username refuses a colon or whitespace`.
  - `host accepts a hostname only`: `SMTP.Example.com ` becomes `smtp.example.com`; `203.0.113.5`, `smtp.example.com:587`, `[smtp.example.com]` and `http://x` are rejected.
  - `port is one of 25, 465, 587, 2525`.
  - `settings input without a password is valid (keep the stored one)`.
  - `apply request requires the password`.
  - `ApprovedServiceSpecWireSchema accepts siteMail`.
  - `SiteDomainsDtoSchema requires mail`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run packages/contracts/test/mail-relay.test.ts`.
- [ ] **Step 3: Implement.** Add `mail: { configured: false, fromAddress: null }` to the existing `SiteDomainsDto` fixtures in the API and web tests.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(contracts): mail relay settings, IPC schemas and the siteMail spec flag`.

---

### Task 1: Migration 0007 — the encrypted relay settings row

**Files:**
- Create: `packages/database/migrations/0007_mail_relay.sql`, `packages/database/src/mail-relay-repository.ts`
- Modify: `packages/database/src/schema.ts` (`mailRelaySettings`), `src/index.ts`
- Test: `packages/database/test/mail-relay-database.test.ts` (new; same DB setup as `sites-database.test.ts`)

**Interfaces (produces):**
- **SQL, exactly:**

  ```sql
  CREATE TABLE IF NOT EXISTS mail_relay_settings (
    id TEXT PRIMARY KEY CHECK (id = 'default'),
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port IN (25, 465, 587, 2525)),
    username TEXT NOT NULL,
    sender_domain TEXT NOT NULL,
    password_ciphertext_base64 TEXT NOT NULL,
    password_iv_base64 TEXT NOT NULL,
    password_auth_tag_base64 TEXT NOT NULL,
    password_key_version TEXT NOT NULL DEFAULT 'v1',
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```

  **Why a table of its own (builder's call):** `encrypted_secrets` needs an organization foreign key, and the relay belongs to the server, not to an organization.
- **In `mail-relay-repository.ts`:**
  - `MAIL_RELAY_SECRET_AAD = { organizationId: "platform", siteId: null, secretKey: "HP_MAIL_RELAY_PASSWORD" } as const`.
  - `interface MailRelaySettings { host: string; port: number; username: string; senderDomain: string; password: string; updatedAt: Date; updatedByUserId: string | null }`.
  - `getMailRelaySettings(db, masterKey): Promise<MailRelaySettings | null>`, which decrypts.
  - `getMailRelaySettingsPublic(db): Promise<(Omit<MailRelaySettings, "password"> & { ciphertextBase64: string }) | null>`, which never decrypts. The ciphertext is returned only for the apply fingerprint and never reaches a DTO.
  - `upsertMailRelaySettings(tx, masterKey, input: { host; port; username; senderDomain; password: string | null; actorId: string | null }): Promise<void>`. With `password: null` it keeps the stored envelope, and throws when there is no row.
  - `deleteMailRelaySettings(tx): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests:**
  - `settings round-trip through encryption and the row holds no plaintext`: the canary `canary-Relay:pw #1` is absent from `SELECT row_to_json(m)::text`.
  - `a null password keeps the stored envelope`.
  - `a null password with no row throws`.
  - `a second row is impossible` (the CHECK constraint).
  - `the envelope does not decrypt under another AAD`.
  - `delete returns false when there is nothing to delete`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(database): encrypted single-row mail relay settings (migration 0007)`.

---

### Task 2: Executor — site mail files, binds, drift check and the IPC path

**Files:**
- Create: `apps/docker-executor/src/site-mail.ts`
- Modify:
  - `packages/executor-contracts/src/spec.ts`: `siteMail?: boolean` on `ApprovedServiceSpec` and `CreateApprovedServiceSpecInput`, passed through;
  - `apps/docker-executor/src/server.ts`: `handleDeployService` (`:661-680`) passes `siteMail: wireSpec.siteMail`;
  - `apps/docker-executor/src/docker-engine-adapter.ts`:
    - `BuildHardenedContainerOptions.siteMailBinds`;
    - `detectOutOfBandContainerModification` gets `siteMailDir` as a **new last parameter**, so positional callers that pass `expected` do not shift;
    - `deployService` writes the files, adds the binds and connects `MAIL_RELAY_CONTAINER_NAME` to the site network;
    - `purgeSite` disconnects it;
    - a `siteMailDir` option;
  - `.github/workflows/ci.yml`: a `php --version` step after Node setup. The `ubuntu-latest` runner ships PHP, so the shim test below runs in CI instead of silently skipping.
- Test: `apps/docker-executor/test/site-mail.test.ts` (new), `apps/docker-executor/test/docker-executor.test.ts`

**Interfaces (produces):**
- `DEFAULT_SITE_MAIL_DIR = "/var/lib/hosting-panel/site-mail"`.
- `siteMailBinds(dir: string): readonly string[]` returns exactly:
  - `${dir}/hp-mail.php:/var/www/html/wp-content/mu-plugins/hp-mail.php:ro`;
  - `${dir}/hp-mail.ini:/usr/local/etc/php/conf.d/zz-hp-mail.ini:ro`;
  - `${dir}/hp-sendmail.php:/usr/local/lib/hp-mail/hp-sendmail.php:ro`.
- `SITE_MAIL_FILES: Readonly<Record<"hp-mail.php" | "hp-mail.ini" | "hp-sendmail.php", string>>`.
- **`ensureSiteMailFiles(dir: string): Promise<void>`:**
  - `mkdir(dir, { recursive: true })`, then `chmod(dir, 0o755)`;
  - for each file whose content differs, `writeFile` with the `w` flag (in place, same inode), then `chmod(path, 0o644)`. Both `chmod` calls are needed because `hp-docker-executor.service` runs with `UMask=0007`.

  `deployService` calls it before creating a container with `siteMail`, and `main.ts` calls it at start.
- **`hp-mail.php`** (must-use plugin; a **default**, open question 5):

  ```php
  <?php
  /* Plugin Name: Hosting panel email. Managed by the hosting panel; read-only. */
  add_action('phpmailer_init', static function ($m) {
      $m->isSMTP();
      $m->Host = 'hp-mail';
      $m->Port = 587;
      $m->SMTPAuth = false;
      $m->SMTPSecure = '';
      $m->SMTPAutoTLS = false;
      $m->Timeout = 10;
      if ($m->FromName === 'WordPress') {
          $m->FromName = wp_specialchars_decode(get_option('blogname'), ENT_QUOTES);
      }
      if (!$m->getReplyToAddresses() && stripos($m->From, 'wordpress@') !== 0) {
          $m->addReplyTo($m->From, $m->FromName);
      }
  }, PHP_INT_MIN);
  ```

  `PHP_INT_MIN` runs first, so an SMTP plugin the site brings (WP Mail SMTP and similar, hooking at the default priority 10 or later) overrides the host and keeps sending through its own provider. That provider is reachable over the site's edge network.
- **`hp-mail.ini`:** exactly `sendmail_path = "/usr/local/bin/php -n /usr/local/lib/hp-mail/hp-sendmail.php"`.
- **`hp-sendmail.php`** (builder writes the body). Its behaviour:
  - it reads the whole message from stdin and unfolds the headers;
  - it collects recipients from `To`, `Cc` and `Bcc` with `/[^\s<>,;:"]+@[^\s<>,;:"]+/`, and removes the `Bcc` header;
  - it takes the envelope sender from `-f<addr>` / `-f <addr>` in argv, else the `From` address, else `wordpress@localhost`;
  - it speaks SMTP to `getenv('HP_MAIL_HOST') ?: 'hp-mail'` on port `getenv('HP_MAIL_PORT') ?: 587`, with `stream_socket_client` and a 10 s timeout. The env override is only for the test below.
  - It sends EHLO, MAIL FROM, RCPT TO for each recipient, DATA (dot-stuffed, CRLF), QUIT.
  - It exits 0 only on `250` after DATA, and 1 otherwise. A failure writes one line to stderr, never the message.
  - It refuses any address containing CR or LF.
- **`buildHardenedContainerCreatePayload`** appends `options.siteMailBinds` after the volume binds. Each must be one of `siteMailBinds(dir)`, otherwise `HOST_POLICY_DENIED`.
- **`deployService`** passes `siteMailBinds(this.siteMailDir)` only when `spec.siteMail === true`. After the `hp_mariadb` connect, it connects `MAIL_RELAY_CONTAINER_NAME` with alias `MAIL_RELAY_ALIAS`, ignoring a 404 as for `hp_mariadb`.
- **`detectOutOfBandContainerModification(inspect, serviceInstanceId, secretsRootDir, expected?, siteMailDir = DEFAULT_SITE_MAIL_DIR)`** accepts a bind that is exactly one of `siteMailBinds(siteMailDir)`.

- [ ] **Step 1: Write the failing tests:**
  - `deploy with siteMail adds exactly the three read-only binds`. With `siteMail` unset, only the volume bind.
  - `deploy over signed IPC keeps siteMail and adds the binds`: through the real server and client with the mock daemon, the create body's `Binds` include the three strings.
  - `mail binds are not drift, a fourth host bind is`: the three binds → `false`; adding `/etc/passwd:/x:ro` → `true`; the same three under another directory → `true`.
  - `a foreign siteMailBinds entry is refused` → `HOST_POLICY_DENIED`.
  - `ensureSiteMailFiles writes 0644 under umask 0007 and rewrites in place`:
    - run with `process.umask(0o007)` (restored after);
    - the directory mode is `0o755` and each file is `0o644`;
    - after changing a file, the `ino` is kept and the content updated;
    - a second call does not change `mtimeMs`.
  - `deployService connects the mail relay to the site network with alias hp-mail`, and `a missing relay (404) does not fail the deploy`.
  - `purgeSite disconnects the mail relay`.
  - `mu-plugin is a default that a later SMTP plugin overrides`: `SITE_MAIL_FILES["hp-mail.php"]` contains `PHP_INT_MIN`, `$m->Host = 'hp-mail'` and `addReplyTo`.
  - **The shim, run for real** (`it.skipIf(!hasPhp)`; CI has `php`):
    - with a `node:net` fake SMTP server, feed `To: a@x.it\r\nCc: b@x.it\r\nBcc: c@x.it\r\nSubject: s\r\n\r\n.hello`;
    - expected: RCPT TO for all three, no `Bcc:` line in DATA, `..hello` sent, exit 0;
    - a 451 reply to DATA gives exit 1.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): read-only mail plugin, php.ini drop-in and sendmail shim on every WordPress site`.

---

### Task 3: Executor — the `hp_mail_relay` platform container

**Files:**
- Create: `apps/docker-executor/src/mail-relay.ts`
- Modify:
  - `apps/docker-executor/src/docker-engine-adapter.ts`: `applyMailRelay`, a private `execInContainer`, and the `mailRelaySecretDir` and `mailRelayFlushWaitMs` options;
  - `infra/systemd/hosting-panel-tmpfiles.conf`;
  - `infra/linux/bootstrap-dedicated.sh`.
- Test: `apps/docker-executor/test/mail-relay.test.ts` (new), `apps/api/test/infra-layout.test.ts`

**Interfaces (produces):**
- **Constants:** `MAIL_RELAY_NETWORK_NAME = "hp_mail_net"`, `MAIL_RELAY_SPOOL_VOLUME = "hp_mail_relay_spool"`, `DEFAULT_MAIL_RELAY_SECRET_DIR = "/run/hosting-panel/mail-relay"` and `MAIL_RELAY_SASL_FILE = "sasl_passwd"`. The container name and alias come from contracts.
- `buildMailRelaySaslLine(req): string` gives `` `[${host}]:${port} ${username}:${password}\n` ``. It re-checks the field rules (defence in depth) and throws `VALIDATION_ERROR` otherwise.
- **`buildMailRelayContainerPayload({ req, myHostname, secretDirHostPath })`:**
  - `Image`: `MAIL_RELAY_IMAGE`.
  - `Env`, exactly and in this order:
    - `RELAYHOST=[<host>]:<port>`
    - `ALLOW_EMPTY_SENDER_DOMAINS=1`
    - `LOG_FORMAT=plain`
    - `POSTFIX_myhostname=<myHostname>`
    - `POSTFIX_mynetworks=127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`
    - `POSTFIX_smtp_sasl_auth_enable=yes`
    - `POSTFIX_smtp_sasl_password_maps=texthash:/run/secrets/hp-mail/sasl_passwd`
    - `POSTFIX_smtp_sasl_security_options=noanonymous`
    - `POSTFIX_smtp_sasl_tls_security_options=noanonymous`
    - `POSTFIX_smtp_tls_security_level=secure`
    - `POSTFIX_smtp_tls_wrappermode=<yes on 465, else no>`
    - `POSTFIX_local_header_rewrite_clients=permit_mynetworks`
    - `POSTFIX_sender_canonical_classes=envelope_sender,header_sender`
    - `POSTFIX_sender_canonical_maps=static:noreply@<senderDomain>`
    - `POSTFIX_smtpd_client_message_rate_limit=200`
    - `POSTFIX_smtpd_client_event_limit_exceptions=127.0.0.0/8`
    - `POSTFIX_anvil_rate_time_unit=3600s`
    - `POSTFIX_smtpd_recipient_limit=100`
    - `POSTFIX_message_size_limit=26214400`

    **No `POSTFIX_*` value may be empty**: the image turns an empty one into `postconf -#`, which restores the default. The builder asserts this.
  - **Labels:** `io.hostingpanel.managed=true`, `io.hostingpanel.role=mail_relay`, and `io.hostingpanel.config_sha256` = sha256 of the canonical JSON of `{ Image, Env, Binds (sorted), CapAdd }`. The password is not in it.
  - **`HostConfig`:**
    - `CapDrop ["ALL"]`, and `CapAdd ["CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"]` (trimmed live by Task 9 step 2 from the six first planned, which also had `FOWNER` and `NET_BIND_SERVICE`);
    - `no-new-privileges`;
    - `Memory` and `MemorySwap` 134217728, `NanoCpus` 500000000, `PidsLimit` 128;
    - `RestartPolicy unless-stopped`;
    - `LogConfig { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } }`;
    - `NetworkMode hp_mail_net`;
    - `Binds [`${secretDirHostPath}:/run/secrets/hp-mail:ro`, "hp_mail_relay_spool:/var/spool/postfix"]`;
    - no `PortBindings`. A `docker.sock` path gives `HOST_POLICY_DENIED`.
- **`DockerEngineSocketAdapter.applyMailRelay(req: MailRelayApplyRequest | null): Promise<void>`**, serialized like `ensureSharedDatabase`:
  - **`null`:** stop and remove the relay (404 ignored), `overwriteAndUnlinkSecretFile(<dir>/sasl_passwd)`, and keep the volume.
  - **A config:**
    1. Require `<dir>` to be a directory owned by the executor's uid. Otherwise `HOST_POLICY_DENIED` "Run bootstrap first".
    2. Write `sasl_passwd` with `writeFileAtomically(path, line, 0o444, 0o755)`. Remember whether the content changed.
    3. `ensureNetwork("hp_mail_net", { internal: false, labels })`, `ensureVolume`, `ensureImageAvailable`.
    4. Create, or recreate **only** on a label mismatch (with `v=true`). Start it if it is stopped.
    5. If it was not created or recreated and the content changed, `POST /containers/hp_mail_relay/restart?t=10`.
    6. After any create, recreate or restart, **flush**: `execInContainer("hp_mail_relay", ["postqueue", "-f"])`. That is `POST /containers/<id>/exec` with `{ Cmd, AttachStdout: false, AttachStderr: false }`, then `POST /exec/<id>/start` with `{ Detach: true }`, then `GET /exec/<id>/json` until `Running: false`.
       - It is retried every 2 s for up to `mailRelayFlushWaitMs` (default 30 000) while `ExitCode !== 0`, because the Postfix master may still be starting.
       - A flush that never succeeds is logged as `{"event":"mail_relay_flush_failed"}` and does not fail the apply. The queue's own backoff still delivers later.
    7. `reconnectToRoleNetworks("site_internal", MAIL_RELAY_CONTAINER_NAME, [MAIL_RELAY_ALIAS])`.
  - `myHostname = this.panel?.hostname ?? "hp-mail.localdomain"`.
  - The whole apply fits the client's 300 s (pull 240 s + flush 30 s + the rest).
- **tmpfiles:** `d /run/hosting-panel/mail-relay 0755 hp-executor hp-executor -`. The parent `/run/hosting-panel` is `3770 root:hp-ipc`, so only `hp-ipc` members (hp-api, hp-agent) and root can reach the file. ADR 0018 records this (minor 4).
- **Bootstrap:** `install -d -m 0755 -o hp-executor -g hp-executor` for both `/run/hosting-panel/mail-relay` and `/var/lib/hosting-panel/site-mail`. The dry-run text lists both.

- [ ] **Step 1: Write the failing tests** in `mail-relay.test.ts`:
  - `relay env enforces the header rewrite for site clients`: the env contains `POSTFIX_local_header_rewrite_clients=permit_mynetworks`, `POSTFIX_sender_canonical_classes=envelope_sender,header_sender` and `POSTFIX_sender_canonical_maps=static:noreply@mail.hostingco.it`.
  - `site clients are not exempt from the rate limit`: it contains `POSTFIX_smtpd_client_event_limit_exceptions=127.0.0.0/8` and `…message_rate_limit=200`, and no `POSTFIX_*=` line has an empty value.
  - `relay requires verified TLS`: `POSTFIX_smtp_tls_security_level=secure`; port 465 gives `wrappermode=yes`.
  - `relay binds only a tmpfs directory and a named volume, never a tmpfs file`.
  - `sasl line keeps the password verbatim and the payload never contains it`.
  - `the config hash ignores the password`.
  - `apply creates the relay, writes the secret 0444, attaches site networks and flushes`: in the mock, one `POST /containers/hp_mail_relay/exec` with `Cmd ["postqueue","-f"]`.
  - `apply restarts and flushes the relay only when the password file changes`:
    - an identical apply → no create, restart or exec;
    - a password change → one restart and one exec;
    - a host change → a recreate and one exec.
  - `apply after the secret file vanished (reboot) restarts and flushes once`.
  - `a flush that keeps failing does not fail the apply` (`ExitCode 1` for every exec, `mailRelayFlushWaitMs: 50`).
  - `apply null removes the container and wipes the secret but keeps the volume`.
  - `apply refuses when the secret directory is missing or not the executor's`.
  - In `infra-layout.test.ts`: `tmpfiles creates the mail relay secret directory`, and `bootstrap dry-run creates the mail directories`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Extend `mock-docker-daemon.ts` with `POST /containers/<id>/restart`, `POST /containers/<id>/exec`, `POST /exec/<id>/start` and `GET /exec/<id>/json`, plus `DELETE /volumes/<name>` recording.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Also run `bash -n infra/linux/bootstrap-dedicated.sh`.
- [ ] **Step 5: Commit** `feat(docker-executor): hp_mail_relay platform container with tmpfs credentials, a persistent queue and flush on credentials`.

---

### Task 4: Executor — delivery log parser, local submission and the test email

**Files:**
- Create: `apps/docker-executor/src/mail-relay-status.ts`, `apps/docker-executor/src/smtp-submit.ts`
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts` (`getMailRelayStatus`, `sendTestMail`)
- Test: `apps/docker-executor/test/mail-relay-status.test.ts` (new), `apps/docker-executor/test/smtp-submit.test.ts` (new)

**Interfaces (produces):**
- `interface MailDelivery { at: string; queueId: string; recipient: string; status: "sent" | "deferred" | "bounced"; problem: MailProblem | null; detail: string }`.
- **`parsePostfixDeliveries(lines: readonly ServiceLogLine[]): MailDelivery[]`:**
  - matches `/postfix\/(?:smtp|error|qmgr)\[\d+\]: ([0-9A-Za-z]+): to=<([^>]*)>,.*? status=(sent|deferred|bounced) \((.*)\)\s*$/` anywhere in `text`;
  - `at` is the Docker log timestamp (`timestamps=1`);
  - `detail` is `redactSensitiveString(reason).slice(0, 300)`;
  - `problem` is `null` for `sent`.
- **`classifyMailProblem(status, reason): MailProblem`.** The first match wins:

  | Condition | Result |
  |---|---|
  | `SASL authentication failed` or ` 535 ` | `auth_failed` |
  | `sasl_passwd`, `unknown mail transport error`, `No such file` or `delivery temporarily suspended` | `credentials_missing` |
  | `TLS`, `STARTTLS`, `certificate` or `Cannot start TLS` (case-insensitive) | `tls_failed` |
  | `Connection timed out`, `Connection refused`, `Network is unreachable`, `Host not found` or `connect to` | `unreachable` |
  | `status = bounced` | `rejected` |
  | anything else | `other` |

  Task 9 step 6 checks the `credentials_missing` texts against real output.
- **`summarizeMailDeliveries(d, sinceMs): { sentCount: number; failures: MailFailureDto[] }`:** the latest entry per queue ID; `deferred` and `bounced` entries newest first, at most 50.
- **`submitLocalMail(opts: { host; port; heloName; from; to; subject; text; timeoutMs }): Promise<{ queueId: string }>`:**
  - `node:net` only, with no TLS and no AUTH;
  - multi-line replies; `2xx` required at each step and `354` after DATA;
  - dot-stuffing and CRLF;
  - it parses `queued as ([0-9A-Za-z]+)`;
  - CR, LF or `<>` in `from` or `to`, or CR or LF in `subject`, throws `VALIDATION_ERROR` before connecting;
  - any other failure throws `MAIL_RELAY_UNAVAILABLE`.
- **`getMailRelayStatus({ since })`:**
  - a 404 inspect gives `{ present: false, running: false, sentCount: 0, failures: [] }`;
  - otherwise logs with `timestamps=1&since=<unix s>&tail=5000`, then demux, parse and summarize.
- **`sendTestMail({ to, from }): Promise<MailTestResult>`:**
  1. The relay must be running, otherwise `MAIL_RELAY_UNAVAILABLE`.
  2. The host is `NetworkSettings.Networks.hp_mail_net.IPAddress`.
  3. `submitLocalMail` with a **5 s** timeout, the subject `Email di prova dal pannello / Test email from the hosting panel`, and a fixed bilingual body.
  4. Poll the log every 1 s for up to 20 s for that queue ID. Nothing found gives `pending`.

  The worst case, about 26 s, fits the client's default 35 s and the BFF's 45 s (Task 7). The test mail comes from the host's bridge address, so it counts toward that address's 200/h. That is fine.

- [ ] **Step 1: Write the failing tests:**
  - `parsePostfixDeliveries classifies auth, connect, TLS and bounce lines`, with real Postfix shapes and a Docker timestamp prefix:
    - `postfix/smtp[123]: 4ABC1234: to=<guest@example.org>, relay=smtp.example.com[203.0.113.5]:587, delay=1.2, delays=0.1/0/0.6/0.5, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as XYZ)` → `sent`;
    - `…: 4ABC1235: to=<a@b.it>, relay=none, delay=30, delays=0.1/0/30/0, dsn=4.4.1, status=deferred (connect to smtp.example.com[203.0.113.5]:587: Connection timed out)` → `unreachable`;
    - `…: 4ABC1236: to=<a@b.it>, relay=smtp.example.com[203.0.113.5]:587, …, dsn=4.7.0, status=deferred (SASL authentication failed; server smtp.example.com[203.0.113.5] said: 535 5.7.8 Error: authentication failed)` → `auth_failed`;
    - `…: 4ABC1237: to=<a@b.it>, …, dsn=5.1.1, status=bounced (host smtp.example.com[203.0.113.5] said: 550 5.1.1 <a@b.it>: Recipient address rejected (in reply to RCPT TO command))` → `rejected`;
    - `…: 4ABC1238: to=<a@b.it>, relay=none, …, dsn=4.7.5, status=deferred (Server certificate not verified)` → `tls_failed`;
    - `postfix/qmgr[90]: 4ABC1239: to=<a@b.it>, relay=none, delay=60, …, status=deferred (delivery temporarily suspended: unknown mail transport error)` → `credentials_missing`.
  - `a deferred message shows once with its latest reason`.
  - `failures are newest first and capped at 50`.
  - `submitLocalMail speaks SMTP and returns the queue id` (a `node:net` fake server; dot-stuffing asserted).
  - `submitLocalMail refuses CR or LF in an address`: the fake server sees no connection.
  - `submitLocalMail fails cleanly on a 421 greeting or a timeout` → `MAIL_RELAY_UNAVAILABLE`.
  - `sendTestMail reports pending when no delivery line arrives in time` (adapter option `mailTestPollMs: 50`).
  - `sendTestMail returns the classified outcome`.
  - `status reports an absent relay without failing`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Task 9 step 5 checks every fixture against real Postfix output, and fixes the parser in this branch if needed.
- [ ] **Step 5: Commit** `feat(docker-executor): mail delivery status from the relay log and a test email`.

---

### Task 5: Executor port, IPC routes, client and simulator for mail

**Files:**
- Create: `packages/executor-contracts/src/mail-relay.ts` (types inferred from the Task 0 schemas)
- Modify: `packages/executor-contracts/src/port.ts`, `phase1-executor.ts`, `index.ts`; `apps/docker-executor/src/server.ts`, `client.ts`, `simulator-adapter.ts`, `main.ts`
- Test: `apps/docker-executor/test/docker-executor.test.ts` (`describe("mail relay IPC")`), `packages/executor-contracts/test/executor-contracts.test.ts`

**Interfaces:**
- **Consumes:** Tasks 0, 2, 3 and 4.
- **Produces:**
  - **`DockerExecutorPort` gains:**
    - `applyMailRelay(req: MailRelayApplyRequest | null): Promise<void>`;
    - `getMailRelayStatus(req: { since: string }): Promise<MailRelayStatusReport>`;
    - `sendTestMail(req: { to: string; from: string }): Promise<MailTestResult>`.
  - **IPC routes:**
    - `POST /v1/mail-relay/apply` (client timeout 300 s);
    - `POST /v1/mail-relay/status` (35 s);
    - `POST /v1/mail-relay/test` (35 s).

    Each is parsed with its schema through the existing `parseBody`.
  - `Phase1DisabledDockerExecutor` throws `NOT_SUPPORTED` for all three.
  - **Simulator:**
    - `mailRelay`;
    - `mailRelayApplies` (append-only);
    - `failNextMailRelayApply(n = 1)`;
    - `mailDeliveries`;
    - `nextTestMailResult` (default `sent`);
    - `deployedSpecs` keep `siteMail`.
  - **`main.ts`** (real backend): `ensureSiteMailFiles(DEFAULT_SITE_MAIL_DIR)` at start, logged on failure and never crashing. `prewarmSiteImages` also pulls `MAIL_RELAY_IMAGE`: about 60 MB on every server, even one that never configures mail. ADR 0018 records that choice.

- [ ] **Step 1: Write the failing tests:**
  - `mail relay apply goes through the signed IPC and reaches the adapter`.
  - `apply IPC rejects a password with a newline before the adapter runs` → 400 `VALIDATION_ERROR`; the response body does not contain the submitted value.
  - `a failed apply never leaks the password in the IPC error or on the console`:
    - `vi.spyOn` `console.log`, `console.error`, `console.warn` and `process.stdout.write`;
    - the mock daemon returns 500 on create, with the password `canary-ipc-pw`;
    - neither the client's thrown error, nor the raw IPC response body, nor any captured output contains `canary-ipc-pw`.
  - `status and test round-trip their wire schemas`.
  - `phase1 executor refuses mail calls with NOT_SUPPORTED`.
  - `simulator records applies and returns the configured test result`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(executor-contracts): mail relay apply, status and test over signed IPC`.

---

### Task 6: API — relay settings, asynchronous apply, test email, and `siteMail` on every WordPress site

**Files:**
- Create: `apps/api/src/mail/mail-relay.service.ts`, `apps/api/src/mail/site-mail-upgrade.ts`, `apps/api/src/controllers/admin-mail-relay.controller.ts`
- Modify:
  - `apps/api/src/runtime/service-spec.ts`: `"siteMail"` joins `STRUCTURED_CONFIG_KEYS` (`:33-40`), and `siteMail: cfg["siteMail"] === true`;
  - `apps/api/src/sites/managed-sites.service.ts`: the first revision of a new site (`:193`) gets `siteMail: true`;
  - `apps/api/src/sites/site-domains.service.ts`: `list` fills `mail`;
  - `apps/api/src/tokens.ts` and `create-app.ts`: `mailRelayRetryIntervalMs` (env `HP_MAIL_RELAY_RETRY_INTERVAL_MS`). The default is `60_000` when listening and the backend is not `disabled`, else `null`, mirroring `domainReconcileIntervalMs`. The loop is started and stopped next to the domain reconciler;
  - `apps/api/src/app.module.ts`.
- Test: `apps/api/test/mail-relay.integration.test.ts` (new; `local-simulator`), `apps/api/test/managed-sites.integration.test.ts`

**Interfaces:**
- **Consumes:** Tasks 0, 1 and 5; `requireServerAdmin`, `appendAuditEvent`, `enqueueOperationTransactional`, `appendStackRevisionTransactional` and `SERVICE_STEPS` (as `managed-sites.service.ts:403-430` uses them for a PHP change).
- **Produces, `MailRelayService`:**
  - **`get(): Promise<MailRelaySettingsDto>`.** It reads with `getMailRelaySettingsPublic`, so it never decrypts. `applied` means `#appliedFingerprint === fingerprint(row)`. When configured, it also calls `getMailRelayStatus({ since: now − 24 h })`; on an executor error it returns `relayRunning: null`.
  - **`save(input, actorId): Promise<MailRelaySettingsDto>`:**
    - No row and no `password`: `VALIDATION_ERROR` with message key `password_required`.
    - In one transaction: upsert, plus audit `admin.mail_relay.update` with `{ host, port, username, senderDomain, passwordChanged }`.
    - Then `void this.ensureApplied()`, **not awaited**, and return the DTO (`applied: false` until the apply lands).

    The request never waits for an image pull. The page polls (Task 7).
  - **`clear(actorId)`:** delete the row, audit `admin.mail_relay.clear`, then `void this.ensureApplied()`, which applies `null`.
  - **`sendTest(to, actorId)`:**
    - when not configured, `VALIDATION_ERROR` with message key `not_configured`;
    - when not `applied`, `MAIL_RELAY_UNAVAILABLE`;
    - otherwise `executor.sendTestMail({ to, from: "noreply@" + senderDomain })`, then audit `admin.mail_relay.test` with `{ to, outcome, problem }`;
    - an executor `MAIL_RELAY_UNAVAILABLE` passes through as 503.
  - **`customerView()`:** `{ configured, fromAddress: "noreply@" + senderDomain | null }`.
  - **`ensureApplied(force = false): Promise<void>`:**
    - the fingerprint is `sha256(host|port|username|senderDomain|ciphertext|updatedAt)`, or `"none"` when there is no row;
    - it does nothing when the fingerprint equals `#appliedFingerprint` and `!force`;
    - otherwise it decrypts, calls `applyMailRelay`, and stores the fingerprint;
    - errors are logged as `{"event":"mail_relay_apply_failed","code":…}` only.
  - **`startBackgroundLoop()` / `stop()`:**
    - `ensureApplied()` runs at once, then every `mailRelayRetryIntervalMs`;
    - every 10th tick it runs `ensureApplied(true)`, so a changed relay payload after an executor-only update is reconciled within 10 min;
    - each tick also runs `upgradeSitesToSiteMail()`.
    - **A boot with no row applies `null` once,** which removes a leftover relay.
    - All executor calls go through one `#serial` chain.
- **`upgradeSitesToSiteMail(db, now): Promise<number>`** (in `site-mail-upgrade.ts`; open question 7, recommended answer):
  - for each managed site (`php_version IS NOT NULL`) in status `ready` whose current revision's `declarativeConfig.siteMail !== true`, in one transaction:
    - `enqueueOperationTransactional` (`service.deploy`, lock `site:<id>`, no actor);
    - `appendStackRevisionTransactional` with the same config plus `siteMail: true`.
  - `RESOURCE_LOCKED` is skipped and retried on the next tick.
  - It returns the number enqueued, and triggers the outbox when that is above 0.
  - Sites in other states are picked up once they are `ready`.
  - Idempotent: an upgraded revision is skipped forever.
- **Routes** under `v1/admin/mail-relay`, each guarded by `requireServerAdmin`: `GET`, `PATCH` (body `MailRelaySettingsInputSchema`), `DELETE`, `POST test` (body `SendTestMailInputSchema`).
- `SiteDomainsService.list` sets `mail: await this.mailRelay.customerView()`.

- [ ] **Step 1: Write the failing tests:**
  - `admin saves settings and the relay is applied`: PATCH with the password `canary-API:pw 1` → 200 with `applied: false`. After the loop tick, GET gives `applied: true` and `simulator.mailRelay.password === "canary-API:pw 1"`.
  - `save answers before the apply finishes`: the simulator's apply is held on a promise; PATCH still returns 200.
  - `the password never leaves the API in a response or an audit row` (save, GET, test, and a failed apply).
  - `saving without a password keeps the stored one` → `passwordChanged: false`.
  - `the first save requires a password` → 400 with `message` `password_required`.
  - `boot applies stored settings and retries until the executor answers`: a new app on the same DB with `failNextMailRelayApply(2)` and `mailRelayRetryIntervalMs: 20` → after two failures it applies the stored config, then no extra applies until the forced 10th tick.
  - `boot with no settings removes a leftover relay` → `mailRelayApplies` starts with `null`.
  - `test email outcome maps to the admin result`, with an audit row carrying `problem`.
  - `test email before the relay is applied is MAIL_RELAY_UNAVAILABLE` (503), and `before setup` → 400 `not_configured`.
  - `status failures appear in GET` and `GET still answers when the executor is down`.
  - `clear removes the settings and stops the relay`.
  - `only server administrators reach the mail relay routes` (403 for the customer owner).
  - `customers see where their site's email comes from` (domains GET `mail`).
  - `a new WordPress site is deployed with siteMail`: `simulator.deployedSpecs.at(-1).siteMail === true`, and its revision config has `siteMail: true`.
  - `a pre-0.5.0 site is upgraded once with a new revision and a deploy`:
    1. Provision a site, then strip `siteMail` from its current revision config (as 0.4.x wrote it).
    2. One tick → one new revision with `siteMail: true`, one `service.deploy` op that succeeds, and the deployed spec has `siteMail: true`.
    3. A second tick enqueues nothing.
    4. The drift summary shows the site as in sync, because the stored revision hash and the container label agree.
  - `a locked site is upgraded on a later tick` (a `site.provision` holds the lock).
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run apps/api/test/mail-relay.integration.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): mail relay settings with asynchronous apply, test email, and site mail on every WordPress site`.

---

### Task 7: Web — the administrator's Email page and the customer's email note

**Files:**
- Create:
  - `apps/web/src/app/admin/mail/page.tsx`;
  - `apps/web/src/components/admin/mail-relay-form.tsx` (client);
  - BFF `app/api/admin/mail-relay/route.ts` (GET, PATCH, DELETE) and `…/mail-relay/test/route.ts` (POST).
- Modify:
  - `lib/upstream.ts`: the `fetchUpstream` options gain `timeoutMs?: number` (default 8000) for `AbortSignal.timeout`;
  - `lib/bff-proxy.ts`: `forwardToUpstream(req, upstreamPath, method, onSuccess?, opts?: { timeoutMs?: number })`. The test route passes `{ timeoutMs: 45_000 }` **(builder's call)**;
  - `components/layout/sidebar-nav.tsx`: `{ href: "/admin/mail", label: t.mail, icon: Mail }` after Sites;
  - `lib/server-api.ts`: `fetchServerAdminMailRelay()`;
  - `components/customer/domains-panel.tsx`: the email note;
  - `i18n/it.ts` and `i18n/en.ts`: `admin.nav.mail`, `admin.mail.*`, `errors.MAIL_RELAY_UNAVAILABLE` and `site.domains.mail.*`.
- Test: `apps/web/test/admin-mail.test.ts` (new), `apps/web/test/site-domains.test.ts`, `apps/web/test/ui-copy.test.ts`

**Interfaces:**
- **`MailRelayForm({ csrfToken, initial })`** has these sections:
  1. **Settings:**
     - fields host, port (587, 465, 25, 2525; default 587), user name, password and sender domain;
     - the form validates with the contracts schemas before sending, and shows `admin.mail.field.<message key>` under the field;
     - with `passwordSet`, the password is empty with the placeholder `admin.mail.passwordKeep`;
     - "Remove" uses a confirmation that names the consequence.
  2. **Status:**
     - `applied: false` shows `admin.mail.starting`, and the page polls `GET` every 5 s while `!applied`, for at most 5 min;
     - after that it shows `admin.mail.notStarted`;
     - otherwise "Running", "Not running" or "Unknown", plus `sentLast24h`.
  3. **Test:** a recipient field (defaulting to the admin's email) and "Send test email" (disabled while `!applied`). It shows the outcome and problem texts.
  4. **Recent problems:** a table of failures.
  5. **Sender domain hint:** "At your email provider, verify {domain} and publish the SPF and DKIM records it gives you. Without them, messages may land in spam."

  API errors go through `errorMessage(m, code)`, and `VALIDATION_ERROR` uses `admin.mail.field.<message>` when the key exists.
- **Customer note** in `DomainsPanel`, by `initial.mail.configured`.
- **Copy (IT and EN).** The IT texts are faithful translations. Every outcome other than `sent`, and every problem text, ends with a next step.

  | Key | EN text |
  |---|---|
  | `admin.mail.title` | "Outgoing email" |
  | `admin.mail.passwordKeep` | "Leave empty to keep the current password" |
  | `admin.mail.starting` | "Starting email sending on this server…" |
  | `admin.mail.notStarted` | "Email sending has not started yet. Save the settings again; if it still doesn't start, check the panel's Server page." |
  | `admin.mail.field.host_invalid` | "Enter the provider's server name, such as smtp.example.com. IP addresses can't be used, because the secure connection is checked against the name." |
  | `admin.mail.field.password_required` | "Enter the password for the email account." |
  | `admin.mail.field.not_configured` | "Set up outgoing email first, then send a test." |
  | `admin.mail.outcome.sent` | "Delivered to the email provider. Check the inbox of {to}." |
  | `admin.mail.outcome.deferred` | "The email provider did not accept it yet. It stays queued and will be retried; read the problem below to fix it." |
  | `admin.mail.outcome.bounced` | "The email provider refused it. Read the problem below, fix it, then send another test." |
  | `admin.mail.outcome.pending` | "Still being sent. Check Recent problems in a minute." |
  | `admin.mail.problem.auth_failed` | "The provider refused the user name or password. Check them with your email provider and save again." |
  | `admin.mail.problem.unreachable` | "This server cannot reach {host} on port {port}. Check the host and port, and that your cloud provider does not block outgoing port {port}." |
  | `admin.mail.problem.tls_failed` | "The secure connection to {host} failed or its certificate does not match the name. Check the server name with your provider; use 587, or 465 if they ask for it." |
  | `admin.mail.problem.credentials_missing` | "The panel has not passed the password to the email service yet. Wait a minute; if it lasts, save the settings again." |
  | `admin.mail.problem.rejected` | "The provider rejected this message. Read the detail, then check the recipient or the sender domain with your provider." |
  | `admin.mail.problem.other` | "Something went wrong while sending. Read the detail; if it repeats, contact your email provider." |
  | `errors.MAIL_RELAY_UNAVAILABLE` | "Email sending is not running on this server yet. Wait a minute and try again; if it lasts, save the settings again." |
  | `site.domains.mail.configured` | "Emails from your site, such as booking confirmations and contact forms, are sent from {from} with your site's name. Nothing to set up." |
  | `site.domains.mail.notConfigured` | "Your site can't send email yet. Ask your server administrator to set it up, otherwise booking confirmations and contact forms won't arrive." |

  The customer text no longer promises that replies come back: core WordPress mail from `wordpress@…` gets no `Reply-To` (minor 8).

- [ ] **Step 1: Write the failing tests:**
  - `mail relay BFF requires CSRF and forwards GET, PATCH, DELETE and test`.
  - `test email route allows 45 s upstream`: mock `fetch` resolving after 9 s under fake timers. The test route returns the upstream body; the same delay on `GET` gives the existing timeout response.
  - `fetchUpstream keeps the 8 s default`.
  - `admin mail page renders settings without the password and lists failures`.
  - `the page polls while the relay is starting`: `applied: false` triggers a GET after 5 s, and the polling stops once `applied: true`.
  - `mail errors exist in IT and EN`: `errors.MAIL_RELAY_UNAVAILABLE` and every `admin.mail.field.*`, `outcome.*` and `problem.*` key are non-empty in both `it` and `en`, and differ between them.
  - `every failure text names a next step`: each `problem.*` text and the `deferred` and `bounced` outcomes contain at least one of `["Check", "Use", "Wait", "Read", "Save", "Ask", "Enter", "Set up"]` (EN), or `["Controlla", "Usa", "Attendi", "Leggi", "Salva", "Chiedi", "Inserisci", "Configura"]` (IT).
  - `sidebar lists Email for administrators`.
  - `domains panel tells the customer how email is sent`, in both states.
  - `ui-copy.test.ts`:
    - add `relay|smtp|postfix|spf|dkim` to the banned regex;
    - first grep the current customer copy for `queue` / `coda`, and ban them too only if there is no existing legitimate use (minor 9).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Read `apps/web/node_modules/next/dist/docs/` first, as `apps/web/AGENTS.md` asks.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(web): admin outgoing email page and the customer's email note`.

---

### Task 8: ADR 0018, docs and version

**Files:**
- Create: `docs/architecture/adr/0018-outgoing-mail-relay.md` (Italian, the format of ADR 0017)
- Modify:
  - `README.md` (Italian): a section "Email in uscita" covering:
    - what the administrator enters (a provider **hostname**, not an IP);
    - verified TLS;
    - port 587 is preferred;
    - many cloud providers block outgoing port 25;
    - verify the sender domain with SPF and DKIM;
    - the fixed limits, and that a newsletter needs an external service;
    - mail is queued for up to 5 days and flushed when the panel comes back after a reboot;
    - **the update to 0.5.0 restarts each running site once** (a few seconds each);
    - a site's own SMTP plugin keeps priority.
  - `HARNESS.md`: project map entries for `site-mail.ts`, `mail-relay.ts`, `mail-relay-status.ts`, `smtp-submit.ts`, `mail-relay.service.ts` and `site-mail-upgrade.ts`; the two new runtime directories; `boky/postfix:5.2.1-alpine` next to the pinned images.
  - `.agents/brain/state.md`: Step 2c status. `.agents/brain/decisions.md`: the owner's answers to the open questions.
  - `docs/api/openapi.yaml`: the four admin routes, the DTOs, `SiteDomainsDto.mail` and `MAIL_RELAY_UNAVAILABLE`.
  - root `package.json` `version` → `0.5.0`.
- Test: `apps/api/test/infra-layout.test.ts`

**ADR 0018 records:**
- Why a queued Postfix relay, and the image choice and pin (the tag drifts until Step 6 pins digests).
- **The topology fence:**
  - no published port;
  - ports 25 and 587 open only inside Docker networks;
  - `mynetworks` covers private ranges only;
  - the host can submit, which is accepted.

  Sites also have egress over their edge network, so the relay is the **default** way out, not the only one.
- **The secret path:**
  - encrypted row → signed IPC → `0444` file in a `0755` directory under `/run/hosting-panel` (`3770 root:hp-ipc`) → directory bind;
  - `hp-ipc` members (`hp-api`, `hp-agent`) can read the file. That is accepted: hp-api holds the password anyway, and hp-agent is a trusted panel daemon;
  - why a directory and not a `*_FILE` bind;
  - why the site-mail files are written in place and explicitly `chmod`-ed.
- **`CP-01`:** after a reboot with the control plane down, mail is queued and not delivered until the API re-applies; then a restart plus `postqueue -f` flushes it. That is the single exec, with a fixed argv. Sites keep serving.
- **The sender rewrite:** envelope **and** header, which needs `local_header_rewrite_clients`. `Reply-To` is kept when the site sets a real sender.
- **Verified TLS**, so the relay host must be a name. The limits and why `smtpd_client_event_limit_exceptions` must not be empty.
- **The must-use plugin is a default** at `PHP_INT_MIN`, and a site's own SMTP plugin wins.
- **The one-time redeploy on 0.5.0**, through a new revision with `siteMail` (hash-consistent), and why the observe-only drift reconciler could not do it.
- **The capability set** after Task 9 step 2.
- **The image prewarm on every server.**
- **Known limits:**
  - failures come from the last 5000 log lines;
  - there is no per-site attribution;
  - there is no per-site relay;
  - the volume is never cleaned;
  - Docker creates `wp-content/mu-plugins` and an empty `hp-mail.php` mount point inside the site volume, owned by root, and they will appear in Step 3 backups and Step 4 imports.

Status `APPROVATO — Step 2c`. Migration `0007`.

- [ ] **Step 1: Write the failing test** `step 2c docs are consistent`: README contains `Email in uscita` and `587`; `openapi.yaml` contains `/v1/admin/mail-relay`; ADR 0018 exists and contains `CP-01` and `postqueue`; the version is `0.5.0`; `MAIL_RELAY_IMAGE` equals `boky/postfix:5.2.1-alpine`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Run it and confirm it passes, plus the four checks.**
- [ ] **Step 5: Commit** `docs: step 2c outgoing mail ADR 0018, README and version 0.5.0`.

---

### Task 9: Container-harness acceptance with a local mail provider (manual)

Use the same harness as `docs/security/step-2b-acceptance-report.md`. Run the full checklist on **Ubuntu 26.04** and **Debian 13**, and step 1 on Ubuntu 24.04 and Debian 12.

**The fake provider:**
- `axllent/mailpit:v1.33.1` at 10.231.0.252 as `mail.provider.test`:
  - SMTP on `:587` with `--smtp-require-starttls`;
  - a leaf certificate for `DNS:mail.provider.test`, signed by a throwaway CA;
  - `--smtp-auth-file` holding `relayuser` and `p:a#s$s w'rd`;
  - the UI on `:8025`.
- A second instance at 10.231.0.253 as `plain.provider.test`, without TLS.

**Harness-only instrumentation (never shipped):** the relay must resolve `mail.provider.test` and trust the throwaway CA. After every create or recreate of `hp_mail_relay`, the operator runs `docker exec`:
1. append the CA to `/etc/ssl/certs/ca-certificates.crt`;
2. append `10.231.0.252 mail.provider.test` and `10.231.0.253 plain.provider.test` to `/etc/hosts`;
3. `postconf -e smtp_host_lookup=dns,native`, then `postfix reload`.

The report lists each time this was done. Everything else uses the shipped payload, including `secure`.

Drive every action through the BFF. Record the results in `docs/security/step-2c-acceptance-report.md`.

- [ ] **Step 1: Install `0.5.0`, and update a `0.4.x` VM with one running site to `0.5.0`.** Expected:
  - exit 0;
  - `/run/hosting-panel/mail-relay` is `0755 hp-executor`, also after a VM reboot;
  - `/var/lib/hosting-panel/site-mail` holds three `0644` files;
  - no `hp_mail_relay` exists before setup;
  - on the updated VM, the existing site is redeployed **once** within 2 minutes of `hp-api` starting (one `service.deploy` in the activity log), and the container has the three binds.
- [ ] **Step 2: Setup and hardening.**
  1. The form refuses the host `10.231.0.252` with the IP message in the UI language.
  2. Save `mail.provider.test`, 587, `relayuser`, the password and `mail.hostingco.test`. The page shows "Starting…", then "Running", without a reload.
  3. `docker inspect` shows no `PortBindings` and the `Binds` from Task 3. `grep -c 'p:a#s'` over the inspect JSON and `journalctl -u hp-api -u hp-docker-executor -u hp-web` gives 0.
  4. **Capabilities:** recreate the relay by hand with each `CapAdd` entry removed in turn, and keep only the needed ones. Update Task 3 and the ADR in this branch.
- [ ] **Step 3: Site mail end to end.**
  1. On `hotel.test`, WordPress "Lost password" arrives with `From: "<site title>" <noreply@mail.hostingco.test>`.
  2. `wp_mail` with `From: info@hotel.test` arrives with that `From:` **header** rewritten and `Reply-To: info@hotel.test`.
  3. `php -r 'var_dump(mail(...Cc...Bcc...));'` → `bool(true)`, three recipients, no `Bcc` header.
  4. `ls -ln`: `wp-content` is owned by 33, and a plugin installs from WP Admin. Record the owner of `mu-plugins`.
  5. **Own SMTP plugin:** install WP Mail SMTP pointed at `plain.provider.test:1025`. A test from it lands in **that** Mailpit, with the site's own `From`. Remove the plugin: mail goes through the relay again.
- [ ] **Step 4: The fence and abuse limits.**
  1. `nc 10.231.0.10 587` and `nc 10.231.0.10 25` from outside are refused.
  2. A raw SMTP session from a site container with `MAIL FROM:<ceo@bank.test>` and the header `From: ceo@bank.test` arrives with **both** rewritten.
  3. 210 `wp_mail` calls: 200 arrive, and the last 10 return false (4xx).
- [ ] **Step 5: Failure reporting**, each through the browser BFF, each answered in under 30 s and shown in IT and EN:
  1. a wrong password → `auth_failed`;
  2. `plain.provider.test` on 587 → `tls_failed`;
  3. Mailpit restarted with a certificate for another name → `tls_failed`;
  4. 587 blocked by an nft rule → `unreachable`, plus a deferred row;
  5. unblock → the deferred mail arrives.

  Record every real Postfix line, and fix the Task 4 fixtures if they differ.
- [ ] **Step 6: `CP-01`.**
  1. Stop all units: `wp_mail` still delivers.
  2. Disable `hp-api`, reboot, then send 3 `wp_mail`: they return true, and the log shows `credentials_missing`-class deferrals (record the real text).
  3. Enable and start `hp-api`. Within 60 s the relay restarts once, the exec flush runs, and the 3 messages arrive once each (count the Message-IDs).
- [ ] **Step 7: Update and remove.**
  1. `hp-update` to `0.5.1`: the relay ID is unchanged, no site is redeployed again, and a `wp_mail` loop loses nothing.
  2. "Remove": the container and `sasl_passwd` are gone, the volume stays, and `wp_mail` returns false.
- [ ] **Step 8: Write the report and commit** `docs(security): step 2c container-harness acceptance report`.

**Not possible in this harness, so left to Task 10:** a real provider with real SPF and DKIM, real CA verification, inbox placement, cloud outbound port policy, and a real kernel reboot.

---

### Task 10: Real-VM acceptance with a real email provider (manual, owner)

Run on the owner's 2b VM. Use the owner's transactional email account, with a verified sender domain (SPF and DKIM published), and a real inbox. Append the results to `docs/security/step-2c-acceptance-report.md`.

- [ ] **Step 1: Update to `0.5.0`** with `hp-update`. Expected:
  - the 2b site is redeployed once automatically;
  - a curl loop shows HTTPS back within 15 s (record the gap);
  - the site has the binds.
- [ ] **Step 2: Setup and test.** Save the provider's hostname on 587. The test → "Delivered". The message lands in the inbox, and `Authentication-Results` shows `spf=pass` and `dkim=pass` for the sender domain.
- [ ] **Step 3: The real site.** A contact form or "Lost password" reaches the owner's inbox from `"<site title>" <noreply@<sender domain>>`.
- [ ] **Step 4: Port policy.** Record whether 25, 465 and 587 are blocked outbound. If 587 is blocked, record the provider's procedure, and the README must say it.
- [ ] **Step 5: `CP-01` with a real reboot.** Disable `hp-api` and reboot; send one form; enable `hp-api`. The email arrives once, within 2 minutes.
- [ ] **Step 6: Customer view** in IT and EN.
- [ ] **Step 7: Write the report and commit** `docs(security): step 2c real-VM acceptance with a real email provider`. The report must PASS before this branch merges.

---

## Open questions for the owner

1. **Which sender address do site emails use?**
   - **Recommended, and built:** `noreply@<sender domain>`, with the site's name as the display name and the site's own address as `Reply-To`.
     - It works on day one with one verified domain.
     - The customer has no DNS work, and no address can be forged.
   - **The alternative** keeps the site's own address. Every customer domain must then be verified at the provider, and the customer must publish SPF and DKIM.
   - **If the owner picks it:** Task 3 drops the canonical lines and adds an allowlist of verified domains; Tasks 0, 6 and 7 add a "verified domains" list and the per-site hint (question 4). About +1 task.
2. **Do customers see send failures?**
   - **Recommended:** the administrator only. The customer cannot fix the server's email account.
   - **If yes:** each failure must be traced to its site (the relay log's client IP mapped to the site's container), shown on the site's Overview with plain texts. +1 task.
3. **Panel password-reset emails: in 2c, or later?**
   - **Recommended:** later, with the email notifications of Step 6. Admin reset and break-glass already cover recovery.
   - **If now:** +2 tasks: a reset-token table and page with IT/EN templates and rate limits, and a fixed-template `sendPanelMail` in the executor.
4. **An SPF/DKIM hint per site?**
   - **Recommended,** following answer 1: no. The customer gets "sent from noreply@…, nothing to set up", and the admin page carries the SPF/DKIM hint for the one sender domain.
   - **If answer 1 is the site's own address,** the per-site hint is required (Task 7 grows by one panel, plus admin-entered DNS values in Tasks 0 and 6).
5. **An imported site already has a working SMTP plugin (its own provider and domain). Who wins?**
   - **Recommended, and built:** the site's plugin. The panel's must-use plugin hooks at `PHP_INT_MIN`, as a default, and a normal SMTP plugin overrides it. The hotel keeps its own sender.
   - **If the panel should always win** (one path for all mail, every failure visible to the admin): the hook moves to `PHP_INT_MAX`, Task 9 step 3.5 is inverted, and the README warns customers that their SMTP plugin is ignored. No new task.
6. **How strict is the TLS connection to the provider?**
   - **Recommended, and built:** verified (`secure`). The certificate must match the provider's hostname, so the form refuses IP addresses. A machine on the path cannot capture the password.
   - **If the owner wants IP addresses allowed:** `encrypt` is used, with no certificate check, either for IP hosts only or for all hosts. `MailRelayHostSchema` accepts IPv4, Task 3's env branches on it, and ADR 0018 records the weaker guarantee. No new task.
7. **Sites created before 0.5.0: redeploy them automatically on update?**
   - **Recommended, and built:** yes, once, through a new revision with `siteMail`. Each running site restarts once (a few seconds), and mail works everywhere with no action.
   - **If not:** drop `upgradeSitesToSiteMail` from Task 6. Existing sites gain mail only at their next PHP-version change; the README and the admin Email page say so, and Task 10 step 1 changes a PHP version instead. That makes Task 6 smaller.
8. **Sending limits per site.**
   - **Recommended, and built:** fixed defaults of 200 messages an hour per site, 100 recipients per message and 25 MiB per message. That is far above booking and contact-form traffic, and it stops a hacked plugin from burning the provider account. A newsletter needs an external service, as the README says.
   - **If the owner wants higher or adjustable limits:** either change the three constants (no new task), or make them admin settings on the Email page (Tasks 0, 1, 3, 6 and 7 each gain the fields; about +½ task).

## Self-review notes

- **Spec coverage:**
  - §3.10, relay settings: Tasks 0, 1, 6 and 7.
  - Test email: Tasks 4, 6 and 7, live in 9.5 and 10.2.
  - `mail()` and `wp_mail` with no setup, existing sites included: Tasks 2 and 6, live in 9.3 and 10.3.
  - Encrypted password, never in env or logs: Tasks 1, 3, 5 and 6, live in 9.2.
  - Admin failures: Tasks 4, 6 and 7.
  - Customer hint: Task 7, under questions 1 and 4.
  - Non-goals: no published port, nothing receives.
  - Password-reset email: question 3.
  - §7 IT/EN for admin errors too: Task 7.
  - §9 `CP-01`: Tasks 3 and 6, live in 9.6 and 10.5, and ADR 0018.
  - Docker socket only in the executor: Tasks 2, 3 and 6.
  - Docs and version: Task 8.
- **Review findings checked against the code before fixing:**
  - the BFF 8 s timeout is `upstream.ts:46`;
  - `server.ts:661-680` drops unknown spec fields;
  - `UMask=0007` is in `hp-docker-executor.service`;
  - restart is `docker restart` (`docker-engine-adapter.ts:1687`);
  - the edge network is `internal: false` (`:1310`);
  - the drift reconciler is observe-only, so "include `siteMail` in `specHash`" is realised by storing it in the revision config and enqueuing `service.deploy`, not by expecting drift to redeploy.
- **Deferred on purpose:** per-site failure attribution (question 2), Health-page mail alerts, digest pins, server-side DKIM signing, spool cleanup, and IPv6 delivery to the provider.
- **Known risks to verify live:**
  - which capabilities Postfix needs (9.2);
  - the `mu-plugins` mount point owned by root inside the site volume (9.3);
  - the real text of the missing-credentials deferral (9.6);
  - whether the exec flush is ready within 30 s of a restart (9.6);
  - cloud outbound port policy (10.4);
  - the per-site downtime of the one-time redeploy on 0.5.0 (10.1).
