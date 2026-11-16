# Step 6 — Accounts, Password Reset and Support Access: Acceptance Report

This report grows with step 6. Every part below rests on test runs against in-process servers,
an in-memory database (PGlite) and the executor simulator. The one exception is the M5b accept
script, which ran against a real Docker Engine; its result was reported by the QA engineer who ran
it and is marked as theirs. Nothing here was run on a production server.

## M5a: people and access

### Acceptance properties (R179 §4)

| Property | Proven by |
|---|---|
| Every administrator route answers a customer `403` with one audit row; the router walk has a floor of 40 routes | `apps/api/test/admin-route-guard.integration.test.ts`: "the router holds at least 40 administrator, hosts and allocations routes"; "a member and an owner get 403 PERMISSION_DENIED and exactly one denied audit row naming them, and nothing changes" |
| A reset request never tells whether an account exists | `apps/api/test/password-reset.integration.test.ts`: "answers 202, empty and alike, before any mail work, and only the active customer gets a token and a mail"; `apps/api/test/accounts-m5a.qa.test.ts`: "is the same while mail is off, an account's limit is used, the overall limit is used and the pending bound is full"; on the web side `apps/web/test/password-reset.test.ts`: "`${locale}`: after a 202 the markup is the same for any address and never names it" and `apps/web/test/m5a-web-qa.test.ts`: "`${locale}`: a 429, a 500, a 404 or a broken connection shows a catalog text, never the API's message or the address" |
| A link works once | `password-reset.integration.test.ts`: "sets the password once, ends every session, unlocks, and the old password stops working"; `accounts-m5a.qa.test.ts`: "two confirms at once with one token: one 204, one PASSWORD_RESET_INVALID, the winner's password works" |
| A link expires | `password-reset.integration.test.ts`: "refuses an expired token, and the token of an account disabled or made an administrator after the request"; `accounts-m5a.qa.test.ts`: "works just inside its 30 minutes and not just outside" |
| An administrator is never reset by mail | `password-reset.integration.test.ts`: "answers 202, empty and alike, …, and only the active customer gets a token and a mail" and "refuses … the token of an account … made an administrator after the request"; `accounts-m5a.qa.test.ts`: "a planted token for an administrator is refused; hash and sessions stay" |
| A visit opens and closes with an audit row | `apps/api/test/support-access.integration.test.ts`: "open and close each write their audit row, with no secret in the details"; "a second visit closes the first with its close row; never two valid grants" |
| Without a visit the administrator gets `404` | `support-access.integration.test.ts`: "without a visit the site routes answer 404 with no audit row; open lets both through; close shuts them again"; `apps/api/test/support-access-tenancy.integration.test.ts`: "without a visit, with a closed one, and on any other organization: 404 and no audit row on every route" |
| The web cannot reach the support view sideways | `apps/web/test/support-view.test.ts`: "sends an administrator without a visit back to the admin sites with the ended note"; `m5a-web-qa.test.ts`: "getCustomerContext takes the organisation only from who-am-I, whatever the session claims" and "both support routes refuse a site id of a wrong shape, a missing session, a bad CSRF token and a foreign Origin before the upstream" |

### Test runs

Each file was run alone with `timeout 300 corepack pnpm exec vitest run <file>` on Node 26.13.1,
on 2026-11-16 between 19:37 and 19:42 UTC, after the review's repairs, in the order below (the QA
engineers' files last). A file with a case that sends two requests at once was run three times.
After the repairs of round 2 (R182, below) the six files marked "R182 run" were run again, each
alone, the same way, on 2026-11-16 between 20:07 and 20:09 UTC; the other rows are from the run
before.

| File | Written by | Result |
|---|---|---|
| `apps/web/test/m5a-web-qa.test.ts` | QA (web) | R182 run: 35 passed (35); its first run in this cycle failed 3 of 35, the three defects below, and it passed whole after their repair |
| `apps/web/test/admin-administrators.test.ts` | engineers | 16 passed (16) |
| `apps/web/test/password-reset.test.ts` | engineers | 30 passed (30) |
| `apps/web/test/support-view.test.ts` | engineers | 16 passed (16) |
| `apps/web/test/ui-copy.test.ts` | engineers | 5 passed (5) |
| `apps/web/test/i18n.test.ts` | engineers | 6 passed (6) |
| `apps/web/test/bff-guard.test.ts` | engineers | 6 passed (6) |
| `apps/api/test/password-reset.integration.test.ts` | engineers | R182 run: 11 passed (11) |
| `apps/api/test/support-access.integration.test.ts` | engineers | R182 run: 11 passed (11) |
| `apps/api/test/support-access-permissions.test.ts` | engineers | R182 run: 3 passed (3) |
| `apps/docker-executor/test/panel-mail.test.ts` | engineers | 6 passed (6) |
| `packages/database/test/password-reset-repository.test.ts` | engineers | 5 passed (5) |
| `packages/contracts/test/contracts.test.ts` | engineers | 41 passed (41) |
| `apps/api/test/admin-users.integration.test.ts` | engineers | 13 passed (13), three runs, all three agree |
| `apps/api/test/admin-route-guard.integration.test.ts` | QA | 4 passed (4) |
| `apps/api/test/support-access-tenancy.integration.test.ts` | QA | R182 run: 6 passed (6) |
| `apps/api/test/infra-layout.test.ts` (reads the README) | earlier cycles | R182 run: 30 passed (30) |
| `apps/api/test/accounts-m5a.qa.test.ts` | QA | 18 passed (18), three runs, all three agree |

### Defects found by these runs

Both are low. The forwarded `{}` lacks the schema's required fields, so the API controller's parse
refuses it with 400 (read in the source, not run here); the `null` body is the same for every
address, so it tells nothing.

- **The reset BFF routes do not refuse a JSON array.** `apps/web/src/app/api/session/password-reset/request/route.ts:8`
  and `confirm/route.ts:8` destructure the parsed body without checking that it is an object, so
  `[...]` (or `null`, or a string) is forwarded upstream as `{}`. The design asks for a refusal
  before the upstream. Proof, failing when found: `m5a-web-qa.test.ts` "request: over the bound, not JSON,
  or an array is refused before the upstream" and "confirm: …" (expected 400, got the upstream's
  answer). Repaired in the same cycle: both routes now refuse a body that is no JSON object with 400
  before the upstream, proved by those two tests and by `password-reset.test.ts` "request|confirm: a
  JSON body that is no object (null, a string, a number, an array) is refused before the upstream".
- **The request BFF answers 202 with the body `null`, not an empty body.** `apps/web/src/lib/bff-proxy.ts:88`
  serialises the empty upstream body as JSON. The arch-web design says the 202 passes through with
  an empty body. Proof, failing when found: `m5a-web-qa.test.ts` "the request BFF passes the 202 on with
  an empty body, the same for every address". Repaired in the same cycle in the request route
  (`bff-proxy.ts` unchanged): an upstream success now answers 202 with no body, proved by that test.

### Found by the review and repaired in the same cycle

Three reviewers read the whole of M5a and found eight low defects (R181). All eight were repaired.
The table of runs above is after these repairs.

- **A reset lifted a lock made by wrong second-factor codes** (R181.1). Someone who reads the
  mailbox but has no authenticator got five more code guesses with every reset. Now the confirm
  sets the count of wrong passwords to zero and keeps a lock once the count of second-factor attempts
  has reached five (see the second finding of round 2 below for what that count holds); that count
  is never changed (`passwordResetLockFields`,
  `apps/api/src/auth/attempt-limits.ts`). Proof in `apps/api/test/password-reset.integration.test.ts`:
  "keeps a lock made by wrong second-factor codes: the new password with the right code is still
  refused", "lifts a lock made by wrong passwords, and the new password then logs in", and "sets the
  password once, ends every session, unlocks, and the old password stops working" (four wrong codes
  are no lock: the lock goes, the count of 4 stays). The lead saw the first and the third fail with
  the old fields put back.
- **The confirm and a new request for the same account took two rows in opposite order** (R181.2),
  so on PostgreSQL they could deadlock. Now `usePasswordResetToken`
  (`packages/database/src/password-reset-repository.ts`) locks the user's row first, as
  `createPasswordResetToken` does. **No test proves it:** PGlite, the test database, runs one
  transaction at a time, so two transactions never wait for each other there. A comment in the code
  names the order.
- **Two opens of a visit at the same moment could leave two live visits** (R181.3). Now
  `SupportAccessService.open` (`apps/api/src/auth/support-access.service.ts`) locks the
  administrator's own row first in its transaction, so the second open ends the first's visit.
  **No test proves it,** for the same reason. "a second visit closes the first with its close row;
  never two valid grants" (`apps/api/test/support-access.integration.test.ts`) still passes; it sends
  the two opens one after the other.
- **The two public forms could stay silent for a screen reader** (R181.4). The answer replaced the
  form and its focused button. Now the answer box on the forgot page and the done text of the reset
  page take the focus when they appear. Proof in `apps/web/test/password-reset.test.ts`:
  "`${locale}`: the status box that replaces the form (and its focused button) can take the focus"
  and "`${locale}`: done shows the sign-in link; before the fragment is read nothing is claimed".
  These show only that the box can take the focus: a server render runs no code in the browser, so
  the focus move itself is not tested.
- **A reset link that is too long showed the password rule** (R181.5). Now a token the confirm
  schema refuses (over 128 characters) is an invalid link in the browser: the page offers a new link
  and sends nothing. Proof in `password-reset.test.ts`: "a token longer than the confirm schema
  allows is an invalid link, taken out of the address bar and never sent" and "a token of exactly 128
  characters is read and sent as before".
- **The support mark was missing on the not-found page of a visit** (R181.6). Now
  `apps/web/src/app/sites/not-found.tsx` renders inside the sites layout, which carries the mark.
  Proof in `apps/web/test/support-view.test.ts`: "renders inside the sites layout: the banner stays
  during a visit, and only then".
- **An `Origin` that is no URL made the web guard throw (500)** (R181.7). Now `validateCsrfAndOrigin`
  (`apps/web/src/lib/bff-guard.ts`) refuses it with the same 403 as a foreign origin. Proof in the new
  `apps/web/test/bff-guard.test.ts`: "refuses an Origin that is no URL (null from a sandboxed frame,
  or rubbish) like a foreign one, without throwing".
- **An address the API refuses showed "Check the highlighted fields" with nothing highlighted**
  (R181.8). Now the forgot page shows a sentence of its own (`login.forgot.badEmail`), the same for
  every refused address. Proof in `password-reset.test.ts`: "`${locale}`: an address the API refuses
  gets a sentence of its own, the same for every address".

A second round read that repair (R182) and found three low defects. All three were repaired.

- **Opening a visit could deadlock with "Leave" by the same administrator** (R182.1, opened by
  R181.3). `open()` took `FOR UPDATE` on the administrator's row and then deleted the old grant;
  a close deletes the grant first and then writes its audit row, whose `actor_id` makes PostgreSQL
  ask `FOR KEY SHARE` on the same row. Each waited on the other, and one request answered 500 (rolled
  back whole). Now `open()` takes `FOR NO KEY UPDATE`, which still makes two opens wait for each
  other but does not block the key check of the close
  (`apps/api/src/auth/support-access.service.ts`, the first statement of `open()`). **No test proves
  it:** PGlite runs one transaction at a time, so it cannot show a lock or a deadlock. The support
  tests in the table still pass.
- **"A reset lifts a lock made by wrong passwords" was not always true** (R182.2). Under a lock the
  login counts every attempt that carries a second-factor code before it checks the password, so the
  count that keeps a lock also holds such attempts with a wrong password. Someone who knows only the
  address of a customer with a second factor can send five wrong passwords and then five attempts
  with any code: the reset keeps that lock until it runs out, at most 15 minutes. Accepted, no code
  changed: that person could lock the account again after any reset. ADR 0025 §2.3, the OpenAPI
  description of `confirmPasswordReset`, the state note and the comment above
  `passwordResetLockFields` now say it this way and name the case.
- **ADR 0025 said two untrue things about the support view** (R182.3). The mark is also missing on
  an address under `/sites` that matches no page: Next.js shows the root not-found page
  (`apps/web/src/app/not-found.tsx`) there, with no mark and no "Leave". And a visit opened on
  another site of the same customer keeps an open page working, because it covers the same
  organisation; the `404` comes only from "Leave" in another tab or a visit on another
  organisation's site. Section 2.4, limit 16, the README and the state note now say so.

A third review, of the last M5a repair, was done at the start of cycle 11 (R183). It found nothing of
medium weight or more. It found two low findings, both in the documents, and both were corrected in
cycle 11. The first is ADR 0025 limit 16: after a visit on another organisation's site there is no
redirect, and the sites area shows its not-found page under the new visit's mark. The second is the
fourth case without the support mark: the panel cannot read `/v1/me` during a visit.

### Not proven

- No test uses the real Docker Engine: the executor is the simulator throughout.
- The reset mail was never sent through the real mail relay; a local SMTP listener and the simulator
  stand in.
- The last-administrator guard was tested on PGlite, which runs one transaction at a time; the row
  lock on a real PostgreSQL is not proven.
- For the same reason, the lock order of the reset confirm (the user's row, then the token, as in the
  request) and the lock of the administrator's row when a visit opens are argued from how PostgreSQL
  behaves and tested only on PGlite.
- Nobody listened to the two public forms (forgot password, new password) with a real screen reader.
- The "Leave" click and the "open support" click have no test.
- Nobody opened the pages in a browser. The web tests render on the server with
  `renderToStaticMarkup` in a Node environment; the fragment handling of the reset page and the
  dialog's open/close were driven by hand, not by a real browser.
- Named limits of R179 §2, accepted and not tested as defects:
  - audit rows written during a visit carry no mark of the visit (P18 not built);
  - during a visit the heavy-action limit refuses the administrator once the customer has used the
    hour's budget;
  - the customer can read the administrator's opaque user id (`requestedByUserId`) in an operation;
  - `mustChangePassword` is enforced by the web app only;
  - the overall limit of 20 reset mails an hour can be used up by someone who knows seven customer
    addresses.

## M5b: health, alerts and logs

### Acceptance properties (M5B-FRAME §1, D25, D26; rulings R184 to R187)

| Property | Proven by |
|---|---|
| Health shows every part of the panel and every site's container on one page, with a state in words | `apps/api/test/admin-health.integration.test.ts`: "a fresh install lists all eleven parts in contract order; the daemons are unknown, not reporting", "the drift pass stores the panel containers and the disks; the routes derive states and alerts from them", "maps the site row, its restart count and drift reason, and leaks no hash and no Engine text"; `apps/web/test/admin-health.test.ts`: "(e) alerts first, then 11 parts with worded badges, site containers and disks; markup is text" |
| Health keeps answering when the executor, the Engine or the runtime is gone, and never relays Engine text | `admin-health.integration.test.ts`: "with the executor stopped both routes answer from the store: unknown, not reporting", "with the Engine unreachable the containers are unknown, engine unreachable", "with the runtime disabled every runtime part is unknown, runtime disabled, and nothing is raised", "a panel_containers row holding Engine free text is unknown and leaks nothing"; `apps/api/test/admin-health-runtime-down.integration.test.ts` (QA): "executor stopped: …", "Engine unreachable: …", "runtime disabled: …" |
| Eleven of the thirteen alerts are raised when they should be, and not before. **Not proven:** the two alerts of a site's certificate (`certificate_expiring`, `certificate_not_issued`) are raised in no test: the check they are built from is tested (`site-domains.integration.test.ts`), the lines of `admin-health.service.ts` that turn its result into the two alerts are not | `admin-health.integration.test.ts`: "disk at 90 % raises disk_high, at 89 % it does not", "a heartbeat older than the threshold turns its part down and raises component_down", "raises site_container_down only after the grace, and never for a site wanted stopped", "raises each backup kind and restore_undo_incomplete", "raises restore_stuck past the deadline, operation_unknown and operation_stuck, and nothing for a restore inside its deadline", "raises panel_certificate_expiring on an installation with no site after one domain pass, and the banner reads it"; `apps/api/test/ops-acceptance.integration.test.ts` (QA): "reconciling past its lease: no alert before the delay, operation_stuck after, …", "unknown is operation_unknown only after its delay, and carries no error text" |
| Every alert reads as a full sentence with a next step, in English and Italian, and every command it names exists | `admin-health.test.ts`: "(a) every ALERT_KIND gives a full sentence with a next step in en and it", "(a) R186 2.1: restore_stuck promises no outcome: …", "(a) an unknown kind or problem falls back to a neutral sentence, never a raw key or a throw"; `apps/web/test/m5b-web-qa.test.ts` (QA): "13 kinds x en/it x fullest/emptiest: no placeholder, no key, no undefined, and a next step", "every command a sentence names exists: units in infra/systemd, hp-break-glass unlock with its two flags", "every button a sentence names exists with that label in the same catalog". "R186 1a: a container that keeps restarting is not promised back by restarting the executor" (failed on a defect below, passes since the R187 repair) |
| The alert line is on every admin page and tells loading or none, some, and failed apart; a failure is never silent | `admin-health.test.ts`: "(d) loading, none, some and failed are different outputs; failed is a loud alert", "(d) loadAlerts: …", "(h) the admin layout mounts AlertLine inside main, before the page"; `m5b-web-qa.test.ts`: "401, 500, a broken connection and bodies not shaped as the contract all end in 'could not load'", "count and level come from the answer and the worst level wins, in both languages". "an array whose items are not alerts ends in 'could not load', not in an invented count or a crash" (failed on a defect below, passes since the R187 repair) |
| The logs of the five panel containers and of each site's container can be read, by name from a closed list, bounded by `tail` | `apps/api/test/admin-logs.integration.test.ts`: "refuses a component outside the five names with 400 before the executor is called", "reads a site", "reads a panel container", "answers 404 for a panel container that is not there and 503 when the Engine is down, from the simulator"; `apps/docker-executor/test/panel-containers.test.ts`: "reads by name with tail, masks phpMyAdmin query strings only", "a missing container is NOT_FOUND"; `apps/docker-executor/test/panel-containers-qa.test.ts` (QA): "each allowed component reads exactly its fixed container name, …", "a tail above 500 never reaches the Engine; the shared reader clamps to 500" |
| Nothing from the address bar reaches the API unchecked | `apps/web/test/admin-logs-audit.test.ts`: "clamp tail to 1..500 and forward only to their own path with a 40 s timeout", "refuse a component or site id outside the closed forms and forward nothing", "answer 401 without a session and forward nothing"; `m5b-web-qa.test.ts`: "Logs page: bad sources show the 'choose' state and mount no viewer; bad tails fall back to 200", "log routes: a negative tail is 1, any other query is dropped, the path is their own", "the three new routes serve only GET and pass a 403 (not an administrator) through", "Audit: a 200-entry trail, commas only and a non-id entry are dropped: …", "Audit: a hostile From is sent as one encoded value and cannot add a parameter" |
| Hostile values are shown as text on the Health page, the alert line, the log viewer and the audit table | `admin-health.test.ts` (e) above; `m5b-web-qa.test.ts`: "Health page: site name, customer, host name, unknown part and unknown alert are escaped", "the log viewer: tags, terminal escape codes and a 100 000-character line stay text in a wrapping box", "the audit table: actor, action, target and details are text", "no M5b file renders raw HTML" |
| The audit trail is paged in the database, without gaps or repeats | `apps/api/test/admin-audit-paging.integration.test.ts`: "pages 120 events by cursor without gaps or repeats, including equal timestamps", "includes the instant of from and excludes the instant of to", "lets the database cut a page of 50 out of 5000 rows"; `ops-acceptance.integration.test.ts`: "rows inserted between page reads give no duplicate and skip no starting row", "limit 0, -1, 1e9 and abc answer 400, never 500; an injection-shaped cursor is an empty page"; `admin-logs-audit.test.ts`: the Audit page cases. `m5b-web-qa.test.ts` "Audit: To before From is refused, as the filtersInvalid sentence promises" and `admin-audit-paging.integration.test.ts` "answers 400 VALIDATION_ERROR when from is not before to, also as the same instant in another offset" (the first failed on a defect below; both pass since the R187 repair) |
| R148.4: an operation is settled in one transaction, and a pass picks up what is left half-settled | `packages/database/test/settle-operation.test.ts`: "settles succeeded with the caller write in one transaction", "rolls back the write and the reconciling move when the succeeded update fails, and marks the error ambiguousOutcome"; `apps/api/test/operation-recovery.unit.test.ts`: "a reconciling operation with a past lease is swept, settled and frees the site lock"; `ops-acceptance.integration.test.ts`: "provisioning: …", "domains: …", "backups: …", "files: …" (a failed settle leaves nothing claimed as done) |
| The limit across an organisation's sites: 24 heavy actions an hour, customers only | `packages/database/test/backups-repository.test.ts`: "organisation scope refuses the 25th heavy action across sites and ignores platform users"; `ops-acceptance.integration.test.ts`: "24 actions over five sites, then QUOTA_EXCEEDED on any site with nothing written; site limit, other organisation and administrator" |
| The customer's side did not change, and shows no administrator wording | `admin-logs-audit.test.ts`: "the customer page sends the same request as before", "customer texts by default, admin texts when asked"; `m5b-web-qa.test.ts`: "ui-copy's scan reads the M5b customer files and the site section, and its own regex catches planted words", "no admin wording in a section a customer can see", "the two replaced tooMany sentences: …", "a vanished container (404 with the executor's text) shows the customer a catalog sentence, never that text"; `apps/web/test/ui-copy.test.ts`: "customer surfaces avoid infrastructure jargon" |
| D25: a customer gets 403 and one audit row on every new route | `apps/api/test/admin-route-guard.integration.test.ts`: "the router holds at least 40 administrator, hosts and allocations routes", "a member and an owner get 403 PERMISSION_DENIED and exactly one denied audit row naming them, and nothing changes"; `ops-acceptance.integration.test.ts`: "the route list the walk reads holds the four routes, all under the guarded prefix, and the walk has a value for :component"; `admin-health.integration.test.ts` and `admin-logs.integration.test.ts`: "… a customer gets 403 and a denied audit row on both routes" |
| The texts: every M5b key in both catalogs, filled, the Italian translated | `apps/web/test/i18n.test.ts`; `m5b-web-qa.test.ts`: "every M5b key is in both catalogs, filled, not a key name, with the same placeholders", "the Italian is not the English, except names that are the same in both languages" (seven keys: the `component_down` and `siteOption` templates, made only of placeholders; the column "Log"; and four product names: "API (hp-api)", "Docker Engine", "Proxy (Traefik, hp_ingress_proxy)", "phpMyAdmin (hp_phpmyadmin)") |
| Accessibility in the markup | `admin-health.test.ts`: "(e) …" (header cells, worded badges), "hands its value to the root: aria-valuenow, not an indeterminate bar"; `admin-logs-audit.test.ts`: "R186 2.3: the status line says the load ended, …"; `m5b-web-qa.test.ts`: "line: status region, failure is role=alert; …", "Logs page: the source and line pickers have labels", "Audit: dates have labels; Previous and Next have a name and show only where there is somewhere to go" |
| The screen, the BFF routes, the API and the contract fit together | `m5b-web-qa.test.ts`: "each address the screen asks has a route that exports GET and forwards to its controller's path with its query names", "the Audit page's query names are the ones the audit controller reads", "the fields the pages read exist in the contract" (checks over the source text, not a run against the API). `docs/api/openapi.yaml` was read against the routes by hand: paths, `tail` bounds, the audit query names and the error codes match |

### Test runs

Each file was run alone with `corepack pnpm exec vitest run <file>`, one after another, on 2026-11-16 between 21:49 and 21:52 UTC; after the R187 repair the files it touches were run again the same way on 2026-11-16 between 22:04 and 22:06 UTC, and their rows show that run; after the R188 repair `admin-logs.integration.test.ts`, `admin-health-runtime-down.integration.test.ts` and `phase2-api.integration.test.ts` were run again the same way on 2026-11-16 between 22:13 and 22:15 UTC. The time is when the run began. The counts are what vitest printed. No total is given for the whole suite.

| File | Written by | Result |
|---|---|---|
| `apps/web/test/admin-health.test.ts` | engineers | 14 passed (14), 22:06:20 |
| `apps/web/test/admin-logs-audit.test.ts` | engineers | 20 passed (20), 22:06:21 |
| `apps/web/test/ui-copy.test.ts` | engineers | 5 passed (5), 22:06:22 |
| `apps/web/test/i18n.test.ts` | engineers | 6 passed (6), 22:06:22 |
| `apps/api/test/admin-health.integration.test.ts` | engineers | 15 passed (15), 22:04:31 |
| `apps/api/test/admin-logs.integration.test.ts` | engineers | 10 passed (10), 22:13:05 |
| `apps/api/test/admin-audit-paging.integration.test.ts` | engineers | 7 passed (7), 22:05:11 |
| `apps/api/test/operation-recovery.unit.test.ts` | engineers | 3 passed (3), 21:49:58 |
| `apps/api/test/admin-route-guard.integration.test.ts` | engineers | 4 passed (4), 21:50:01 |
| `apps/api/test/site-domains.integration.test.ts` | engineers | 59 passed (59), 21:50:05 |
| `apps/api/test/phase2-api.integration.test.ts` | engineers | 14 passed (14), 22:14:41 |
| `apps/docker-executor/test/panel-containers.test.ts` | engineers | 14 passed (14), 22:06:19 |
| `apps/docker-executor/test/docker-logs.test.ts` | engineers | 3 passed (3), 22:06:20 |
| `apps/host-agent/test/host-agent.test.ts` | engineers | 21 passed (21), 21:51:43 |
| `packages/database/test/settle-operation.test.ts` | engineers | 4 passed (4), 21:51:44 |
| `packages/database/test/backups-repository.test.ts` | engineers | 14 passed (14), 21:51:46 |
| `packages/contracts/test/contracts.test.ts` | engineers | 46 passed (46), 21:51:49 |
| `packages/executor-contracts/test/executor-contracts.test.ts` | engineers | 12 passed (12), 21:51:49 |
| `apps/web/test/m5b-web-qa.test.ts` | QA (web) | 34 passed (34), 22:04:01 |
| `apps/api/test/ops-acceptance.integration.test.ts` | QA (api) | 13 passed (13), 22:04:26 |
| `apps/api/test/admin-health-runtime-down.integration.test.ts` | QA (api) | 15 passed (15), 22:13:21 |
| `apps/docker-executor/test/panel-containers-qa.test.ts` | QA (executor) | 48 passed (48), 22:04:25 |

The nine tests that failed on the seven defects below pass since the R187 repair; none of them was skipped or changed. When a site's container is gone, the customer's log route answers `503` ("The logs are not available right now. Try again in a few minutes.") and the administrator's answers `404` ("There is no log to show: this part is not running on this server."), as `admin-logs.integration.test.ts` "a container that does not exist answers 404" holds (R188). `eslint` on `m5b-web-qa.test.ts` and `corepack pnpm --filter @hosting-panel/web run typecheck` both exited 0.

### Accept script on a real Docker Engine (D26): reported by qa-exec, not run by this report's author

qa-exec ran `accept-m5-health.mjs` against a real Docker Engine (Node 26.13.1, a local busybox image) and reported: `RESULT 6/6 passed (1-container, 2-inspect-running, 3-logs, 4-stopped-then-missing, 5-engine-unreachable, nothing-left)`, exit 0, and `docker ps -a --filter name=hp_swarmtest_m5h -q | wc -l` = 0 afterwards. This result is theirs; it was not repeated for this report.

### Defects found by these runs, repaired by R187

| Defect | What the design says | What the code did | Where | Weight | Test |
|---|---|---|---|---|---|
| The executor restart sentence promises too much | R186 1: a sentence says what a step does and no more | `admin.health.fix.{ingress_proxy,shared_database,sftp}` say `sudo systemctl restart hp-docker-executor` "puts it back". The sentence is also shown for a container that is degraded (restarting, dead or OOM-killed). Docker reports a restarting container as `Running: true`, and the start-up pass acts only when `Running !== true`, so the restart changes nothing | `apps/web/src/i18n/en.ts:1316-1318` and the same keys in `it.ts`; `apps/docker-executor/src/docker-engine-adapter.ts:866,1370,1588,1777,2313` | low | `m5b-web-qa.test.ts` "R186 1a: a container that keeps restarting is not promised back by restarting the executor": repaired by R187 (the sentence now says the restart helps a stopped or missing container only, and sends a restarting one to its log); passes |
| The alert line trusts any array | R185/arch-web: the line is never silently wrong; a bad answer ends in "could not load" | `loadAlerts` accepts any array as the alert list. `[{}]` shows an invented "1 alert, warning". `[null]` makes `worstSeverity` throw while the layout of every admin page renders | `apps/web/src/components/admin/alert-line.tsx:17`; `apps/web/src/lib/admin-alerts.ts:7` | low (the API is the only source, and it is the panel's own) | `m5b-web-qa.test.ts` "an array whose items are not alerts ends in 'could not load', not in an invented count or a crash": repaired by R187 (`loadAlerts` keeps a list only if every item has a string `kind` and a known severity); passes |
| "To before From" is promised to be refused, and is not | `admin.audit.filtersInvalid` says the filters are refused when "From is not before To" | The API checks only the date format. `to` before `from` answers 200 with an empty list, so the page says no event matches. OpenAPI documents only the format check, so the docs match the code; the sentence is the outlier | `apps/api/src/controllers/admin-audit.controller.ts:22-25,64`; `apps/web/src/i18n/en.ts:1261`, `it.ts:1286` | low | `m5b-web-qa.test.ts` "Audit: To before From is refused, as the filtersInvalid sentence promises" (a check over the controller's source): repaired by R187 (`AdminAuditRangeSchema` refuses it with `400 VALIDATION_ERROR`, proven by `admin-audit-paging.integration.test.ts` "answers 400 VALIDATION_ERROR when from is not before to, …"); passes |
| A customer's logs answer 404 with the executor's text when the site's container is gone | the customer side does not change, and Engine text never reaches a customer | `managed-sites.service.ts` passes the executor's NOT_FOUND message through. The web page shows its own catalog sentence instead, so the text does not reach the screen (proven by `m5b-web-qa.test.ts` "a vanished container (404 with the executor's text) shows the customer a catalog sentence, never that text") | `apps/api/src/sites/managed-sites.service.ts:504-507` | medium (found and weighed by qa-api) | `admin-health-runtime-down.integration.test.ts` "point 8: …" "answers neither 500, nor executor text, nor that the site does not exist" (qa-api): repaired by R187 (`503` with the shipped sentence); passes |
| Health and alerts answer 500 when the executor's snapshot is JSON null | Health keeps answering when a part is gone | A `telemetry_snapshot` row holding JSON `null` throws | `apps/api/src/health/admin-health.service.ts:165` | low to medium (qa-api) | `admin-health-runtime-down.integration.test.ts` "docker_executor snapshot is JSON null: health and alerts answer 200" (qa-api): repaired by R187 (a snapshot that is not an object makes the Engine `unknown`, `not_reporting`); passes |
| The executor takes the first of a repeated `component` or `tail` | one value per name | the first value wins without a refusal | `apps/docker-executor/src/server.ts:560-566` | low (qa-exec) | `panel-containers-qa.test.ts` "component=sftp&component=sftp …", "component=shared_database&component=phpmyadmin …", "tail=5&tail=999 is refused with 400 and the Engine sees nothing" (qa-exec): repaired by R187 (a repeated name reaches the route's schema as a list and is refused); all three pass |
| The phpMyAdmin mask stops at an escaped quote | query strings are masked | the pattern ends at `\"`, so the rest of the value shows | `apps/docker-executor/src/docker-logs.ts:56` | low (qa-exec) | `panel-containers-qa.test.ts` "Apache's escaped quote inside the query: no parameter value is left, the rest is unchanged" (qa-exec): repaired by R187 (a backslash and the character after it stay in the query); passes |

Notes, not defects: `disk_high`'s `du -xhd1 /` measures only the root filesystem. The operation_* sentences show the operation kind as a code (for example `site.backups.restore`). Loading and none have the same markup, by design (arch-web D20, held by `admin-health.test.ts`). An empty `tail=` reaches the API as `tail=1`. Terminal escape codes are shown as text, not removed. The BFF routes leave the administrator check to the API, whose 403 passes through.

### Review round 1, repaired by R189

Three reviewers (rev-ops, rev-health, rev-web) read M5b and found one medium and ten low findings;
nothing high, no way to reach what is not one's own, no leak. R189 decided them.

Repaired (R189 1), each with the test that proves it:

- **The `site_container_down` sentence named Start, which is disabled whenever the alert fires** (medium,
  rev-web). It now names Restart, with the label of `site.manage.restart` in each catalog, and so does
  ADR 0026. Checking every other sentence the same way found one more: `backup_failed` named "Back up",
  but the row's button reads Retry once the last attempt failed; it now names Retry.
  `m5b-web-qa.test.ts` "R189 1.1: each sentence names the button that is enabled when its alert fires"
  and "every button a sentence names exists with that label in the same catalog".
- **The not-running clock survived a wanted stop, and a container Docker restarts in a loop never
  alerted** (low, rev-health). The clock is now cleared whenever the service is not wanted running
  (`apps/api/test/admin-health.integration.test.ts` "R189 1.2: a wanted stop clears the clock, so a
  start gets the full grace"). The loop was only partly repaired: the rule of R189 1.3 kept the clock
  only while the restart count rose from one look to the next, but Docker raises the count when the
  container ends, so two looks inside one run saw the same count and stopped the clock. Only loops
  whose runs were shorter than 15 seconds alerted. Round 2 found this; see below. The two R189 1.3
  tests fed a count that rose at every look, which is not what Docker does, and were replaced by the
  R190 tests.
- **Three tests could not fail or failed by chance** (low, rev-ops): the 25-actions check read the
  retry time, the provisioning settle test passed on the old code, the service-recovery audit test
  could not tell inside the transaction from after it. See the engineer's report (r1-api) for the
  names of the repaired tests.
- **The Audit filters kept old text after Clear, Back or Forward; the pager had no name; Health dates
  had no time zone** (low, rev-web). `admin-logs-audit.test.ts` "R189 1.5: the filters are keyed by the
  address, so Clear, Back and Forward empty the boxes"; `m5b-web-qa.test.ts` "Audit: dates have labels;
  Previous and Next have a name and show only where there is somewhere to go" (now also the pager's
  name); `admin-health.test.ts` "R189 1.5: every date on Health and in the alert sentences carries its
  time zone" (run under `UTC` and `Europe/Rome`).
- **Documents** (R189 1.6): OpenAPI says Health lists a site only when it has a web service, and the
  rule of the clock as built; ADR 0026 has the rule, the new limits and this round (its limit 24).

Accepted and written down as limits in ADR 0026 (R189 2): a site moved to another organisation brings
its last hour of heavy actions with it (limit 22); the Logs page has no sentence of its own about
personal data in the SFTP and mail logs (limit 7); fifty stuck restores could hide a newer operation
alert (limit 23). Handed on (R189 3, ADR 0026 limit 24): the customer's Start button is never enabled,
so after Stop the way back is Restart (cycle 12); an operation can stay `queued` holding its site lock
(last milestone, unconfirmed).

The lead ran the nine real-Docker scripts on the reviewed tree on 2026-11-16, before this repair:
`accept-m1-files` 17 of 17, `accept-m1-sftp` 19 of 19, `accept-m2-databases` 17 of 17,
`accept-m2-phpmyadmin` 24 of 24, `accept-m3-backups` 28 of 28, `accept-m3-panel` 13 of 13,
`accept-m4-wordpress` 12 of 12, `accept-m4-import` 13 of 13, `accept-m5-health` 6 of 6; nothing was
left behind. They were not run again after this repair for this report.

### Review round 2, repaired by R190

One reviewer (rev-r2) read the repair of round 1 and found one medium and one low finding. The lead
saw the medium one on Docker 29.9.2 with a throw-away container: the restart count rises when the
container ends, not when it starts again; two looks inside one run see the same count; a restart by
hand sets it back to 0.

- **A rise of the restart count is remembered for two minutes** (medium). The stored look keeps
  `lastRestartAt` beside `notRunningSince`: the time of the newest look whose count was higher than the
  look before (the look's own time). For a service wanted running the clock runs while the container is
  not seen running, or is seen running and the remembered rise is younger than two minutes
  (`SITE_RESTART_QUIET_MS`); it stops, and the rise is forgotten, at the first look that sees it running
  with no rise younger than that. A lower count (a new container, a deploy, the panel's Restart) forgets
  the rise; a wanted stop clears both. Two minutes is longer than Docker's longest wait between two
  restarts (one minute) plus one look (15 seconds), and shorter than the five minutes of the alert
  (`SITE_CONTAINER_DOWN_GRACE_MS`). So one crash alone shows "Restarting or crashed" on Health for two
  minutes and never alerts; a loop whose runs are shorter than two minutes alerts after five minutes; a
  loop whose runs are longer than two minutes does not alert (Health shows it restarting for two minutes
  after each crash; ADR 0026 limit 25). After a restore longer than five minutes the alert can show for
  one look (up to 15 seconds), until the drift pass sees the started container.
  `admin-health.integration.test.ts` "R190 1.1 (a): the history Docker writes (count rises on exit)
  keeps the clock and alerts after the grace", "R190 1.1 (b): runs of 30 s seen by looks every 15 s
  alert as degraded after the grace", "R190 1.1 (c): one crash alone is degraded for two minutes, then
  running, and never alerts", "R190 1.1 (d): a start by hand (count back to 0) stops the clock at once",
  "R190 1.1 (e): a wanted stop forgets the rise"; `packages/database/test/phase2-database.test.ts`
  "10. remembers a restart count rise for two minutes of look time, forgets it on a lower count".
- **A missing container cannot be brought back by Restart** (low). Restart needs a container and fails
  with `NOT_FOUND`. When `observed` is `missing`, `site_container_down` has its own sentence: the
  container was removed outside the panel, restarting it from the panel cannot bring it back, and
  changing the PHP version on the site's page from the support view creates it again (then change it
  back). `admin-health.integration.test.ts` "R190 1.2: a container removed outside the panel is missing,
  and a PHP version change creates it again" (on the simulator; the Engine adapter's deploy removes an
  old container only if there is one, then creates and starts a new one); `m5b-web-qa.test.ts` "R190
  1.2: a missing container gets its own sentence (the PHP version change, no Restart); the other seen
  states keep R189 1.1". Restart and Start that create a missing container again are handed on to
  cycle 12 (M5c).

### Not proven

- The limits R184 §3 accepts:
  - row locks are not proven on a real PostgreSQL under load;
  - `host.*` operations that had finished are called failed;
  - with the runtime disabled no background pass runs, and so no pass settles stuck rows, not even at start (`create-app.ts:536`, posted by qa-api);
  - there is one host only;
  - the banner and the alerts can be one pass old (15 s and 60 s);
  - a recovery that throws after the move to failed raises no alert;
  - only the four places are measured for disk;
  - SFTP and mail logs carry personal data;
  - the phpMyAdmin mask is a pattern;
  - traefik and the mail relay were not run for D11;
  - the alert line is fresh only when the page changes;
  - audit paging stops at 100 pages;
  - the customer log call is still a POST;
  - a log answer is held whole in memory before it is sent.
- A real loop, watched by the real drift pass for five minutes: the R190 clock is proven only with
  looks written by the tests, each with its own time.
- No browser was run: every web property above is proven on the server-rendered markup (`renderToStaticMarkup`) and on route handlers called in Node. Effects run through a mocked `useState`/`useEffect`, not React's own.
- No screen reader was used: accessibility is proven only as roles, labels and names in the markup.
- The check that the screen and the API fit together reads source text. It was not a run of the web app against the running API.
- Only the accept script above touched a real Docker Engine. Every other run used the executor's simulator or a mocked Engine.
