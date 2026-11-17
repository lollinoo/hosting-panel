# Step 6 — Accounts, Password Reset and Support Access: Acceptance Report

This report grows with step 6. Most parts below rest on test runs against in-process servers,
an in-memory database (PGlite) and the executor simulator. A few runs used a real Docker Engine or
a real `nft` in a throw-away container: each one is marked where it is written, with who ran it.
Nothing here was run on a production server.

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
| Each of the thirteen alerts is raised when it should be, and not before. Until cycle 12 the two alerts of a site's certificate (`certificate_expiring`, `certificate_not_issued`) were raised in no test (R191 5); the test named here for them now exists and passed on 2026-11-17 (see "Review round 3 and ruling R191") | `admin-health.integration.test.ts`: "R191 5: raises certificate_not_issued and certificate_expiring for a site's domains, nothing for a healthy one", "disk at 90 % raises disk_high, at 89 % it does not", "a heartbeat older than the threshold turns its part down and raises component_down", "raises site_container_down only after the grace, and never for a site wanted stopped", "raises each backup kind and restore_undo_incomplete", "raises restore_stuck past the deadline, operation_unknown and operation_stuck, and nothing for a restore inside its deadline", "raises panel_certificate_expiring on an installation with no site after one domain pass, and the banner reads it"; `apps/api/test/ops-acceptance.integration.test.ts` (QA): "reconciling past its lease: no alert before the delay, operation_stuck after, …", "unknown is operation_unknown only after its delay, and carries no error text" |
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

### Review round 3 and ruling R191

Round 3 (`review-c11-r3`, one reviewer on the patch of the round-2 repair, tree `a4f80cd`) found
nothing of medium weight or more. R191 closed cycle 11 on that tree and handed three low findings
to cycle 12. The lead read each one against the code and found it true. Where cycle 12 closed
each one, and the test that proves it:

- **R191 1.1** (the missing-container sentence blamed a removal "outside the panel"): closed by
  cycle 12, which rewrote `admin.health.siteContainerMissing` in both catalogs (`en.ts:1307`,
  `it.ts:1332`). It now sends the reader to Restart, which creates the container again, and it
  names no cause. **No test asserts that "outside the panel" or "fuori dal pannello" is absent.**
  `m5b-web-qa.test.ts` "R190 1.2: a missing container gets its own sentence (the Restart button of
  Health, no PHP version change); …" and `m5c-web-qa.test.ts` check what the sentence names. They
  do not check the clause R191 asked to drop.
- **R191 1.2** (one crash, then no more looks: a healthy site alerted for about 105 seconds):
  closed in `admin-health.service.ts`. The proof is `admin-health.integration.test.ts` "R191 1.2:
  one rise, then no more looks, six minutes later raises no site_container_down".
- **R191 1.3** (a rise remembered before a removal survived the redeploy): closed in the rule,
  which forgets the rise on a `missing` look. The proof is
  `packages/database/test/phase2-database.test.ts` "10b. forgets a remembered rise when the
  container is seen missing (R191 1.3)".
- **R191 5** (the two certificate alerts of a site were raised in no test): closed by
  `admin-health.integration.test.ts` "R191 5: raises certificate_not_issued and
  certificate_expiring for a site's domains, nothing for a healthy one". The thirteen-alerts row
  above names it.

This report's author ran each of these files alone with `corepack pnpm exec vitest run <file>` on
2026-11-17. Times are UTC, when the run began:
- `apps/api/test/admin-health.integration.test.ts`: 25 passed (25), 01:38:12.
- `packages/database/test/phase2-database.test.ts`: 15 passed (15), 01:39:44.

The lead ran the nine real-Docker scripts twice more, as R191 3 asks: run `c11d` on tree `6a33229`
and run `c11e` on the final tree `a4f80cd`. The two summaries follow, word for word, from the
summary file of each run (written 2026-11-16 at 23:01 and 23:35 UTC). This report's author did not
run them.

`c11d`:

```
v26.13.1
m1-files exit=0 fail=0 | accept-m1-files: 17/17 passed in 13.3s
m1-sftp exit=0 fail=0 | accept-m1-sftp: 19/19 passed in 35.7s
m2-databases exit=0 fail=0 | accept-m2-databases: 17/17 passed in 21.8s
m2-phpmyadmin exit=0 fail=0 | accept-m2-phpmyadmin: 24/24 passed in 54.9s
m3-backups exit=0 fail=0 | accept-m3-backups: 28/28 passed in 227.2s
m3-panel exit=0 fail=0 | RESULT 13/13 passed in 78s
m4-wordpress exit=0 fail=0 | 12/12 passed in 174.2 s
m4-import exit=0 fail=0 | 13/13 passed in 127.0 s
m5-health exit=0 fail=0 | RESULT 6/6 passed
left-containers=0
left-volumes=0
left-networks=0
left-shm=0
end-accept
```

`c11e`:

```
v26.13.1
m1-files exit=0 fail=0 | accept-m1-files: 17/17 passed in 12.5s
m1-sftp exit=0 fail=0 | accept-m1-sftp: 19/19 passed in 34.9s
m2-databases exit=0 fail=0 | accept-m2-databases: 17/17 passed in 18.7s
m2-phpmyadmin exit=0 fail=0 | accept-m2-phpmyadmin: 24/24 passed in 55.3s
m3-backups exit=0 fail=0 | accept-m3-backups: 28/28 passed in 226.3s
m3-panel exit=0 fail=0 | RESULT 13/13 passed in 78s
m4-wordpress exit=0 fail=0 | 12/12 passed in 170.0 s
m4-import exit=0 fail=0 | 13/13 passed in 128.3 s
m5-health exit=0 fail=0 | RESULT 6/6 passed
left-containers=0
left-volumes=0
left-networks=0
left-shm=0
end-accept
```

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

## M5c: restart and terminal

### Acceptance properties (M5C-FRAME D23, D24; rulings R192 to R196)

| Property | Proven by |
|---|---|
| D23: the walk of the guard covers every new route; a customer gets `403` and an audit row on each | `apps/api/test/admin-route-guard.integration.test.ts`: "the router holds at least 40 administrator, hosts and allocations routes" (it now names the terminal's open, write, read and close routes), "a member and an owner get 403 PERMISSION_DENIED and exactly one denied audit row naming them, and nothing changes"; `apps/api/test/m5c-api-qa.integration.test.ts` (QA): "point 1: … member, owner and a hosting admin without the server role get 403 and one denied row on each, nothing changes, no executor call; no session gets 401"; `apps/api/test/admin-restart.integration.test.ts`: "A.3 a customer gets 403 and a denied row, an unknown site 404, a site under another operation 409", "A.8 the operation read answers 404 for an unknown id and 403 to a customer" |
| D23: an open without a code, with a wrong code or with a used code is refused, audited, and calls no executor | `apps/api/test/admin-terminal.integration.test.ts`: "refuses a missing, malformed, wrong or used code with its denied reason and never calls the executor", "gives code_used to the loser of two opens racing with one code", "locks after five wrong codes: the sixth try is 423 even with a right code", "refuses an administrator without an authenticator with 403", "refuses a site being changed or not running before the code is spent"; `m5c-api-qa.integration.test.ts`: "point 2: … refuses the code the login just spent and the code of the step before the last, with zero executor calls and no row", "a site being removed refuses without spending the code" |
| D23: one open row and one close row, with the duration, for each way a session ends | `m5c-api-qa.integration.test.ts`: "point 3: … closed, shell exit, container stopped, restarted, deployed again and deleted, executor restarted, executor not answering", "the silence limit ends a session as idle", "the session limit ends a session as time_limit, even while it is read" (each checks one open row, one close row with its reason and a whole, non-negative `durationSeconds`); `admin-terminal.integration.test.ts`: "opens with a fresh code, runs a command read by cursor, and closes twice with one close row", "ends the row as not_started with one close row when the executor refuses the open", "closes the row when a read finds the shell ended, and refuses a later write", "closes as executor_gone when the executor forgot the session", "the pass: keeps young rows, closes ended and unknown ones, and does nothing when the list fails" |
| D23: a canary typed into a session and one printed by it appear in no audit row, no operation and no captured log line | `admin-terminal.integration.test.ts`: "stores nothing typed or printed: not in the database, an error or a console call"; `m5c-api-qa.integration.test.ts`: "point 6: … the canary goes through the read, and is in no table, no audit row, no console or stdout call, no error"; `apps/docker-executor/test/m5c-exec-qa.test.ts` (QA): "6. … no input, output or Engine error text reaches a log line, an error or an IPC body", "8. … on the real adapter a session writes no file, and its dropped record keeps no output"; `apps/web/test/m5c-web-qa.test.ts` (QA): "3. … no M5c file logs, stores, or puts anything in a query string", "the BFF routes write nothing of a body or an answer to the console"; `apps/web/test/admin-terminal.test.ts`: "no file writes output or input to markup, console, storage or a URL query" |
| D23: Restart needs a reason and stores it; it acts on exactly the named component; a name outside the list never reaches the Engine | `admin-restart.integration.test.ts`: "A.1 answers 202, writes admin.site.restart with the reason, …", "A.2 refuses a missing, blank or too long reason and a missing key; …", "A.6 refuses an unknown component, an absent one and a second restart while the first is queued"; `m5c-api-qa.integration.test.ts`: "point 7: … a site restart restarts that site's service only and keeps the reason word for word in the audit row only", "a panel restart reaches the executor with exactly the named part; a name outside the five or a bad reason never does"; `apps/docker-executor/test/panel-restart.test.ts`: "restarts exactly the fixed name of each component with its stop time", "a component outside the five never reaches the daemon, directly or over the signed IPC"; `m5c-exec-qa.test.ts`: "7. … each of the five reaches the daemon over IPC with exactly its fixed name and nothing else changes", "no request names another container: slashes, dots, a site's name, capitals, spaces" |
| Executor: each of the six IPC routes refuses a request with no signature, a wrong one or an old one, before the adapter | `m5c-exec-qa.test.ts`: "1. … %s refuses no signature, a wrong one and an old one with 401, before the adapter" (one case for each of the six routes) |
| Executor: a whole session works over the signed IPC on the simulator, and each error code arrives with the HTTP status of `ERROR_CODE_HTTP_STATUS` | `m5c-exec-qa.test.ts`: "2. … open, id, a waiting read answered by output, a read empty at its limit, exit, list, close", the default 20 s wait case, "each executor error code arrives with the HTTP status of ERROR_CODE_HTTP_STATUS", "the real adapter's restart errors arrive with their status too: RESOURCE_LOCKED, NOT_FOUND, INTERNAL_ERROR"; `apps/docker-executor/test/terminal-ipc.test.ts`: "each of the six calls reaches its route and returns the parsed answer", "passes NOT_FOUND and RESOURCE_LOCKED from the port to the client" |
| Executor: 4097 bytes of input (without echoing it), a bad session id, a bad cursor, a component outside the five and an extra key are refused before the adapter | `m5c-exec-qa.test.ts`: "3. … every malformed body is a 400 VALIDATION_ERROR, no port method is called, and no body echoes the input" (4096 bytes, and 4094 bytes plus one two-byte character, still pass); `terminal-ipc.test.ts`: "refuses bad requests with VALIDATION_ERROR before the port is called"; `packages/contracts/test/admin-terminal.test.ts`: "limits input to 4096 UTF-8 bytes with a fixed message", "refuses a negative or fractional cursor", "keeps every DTO strict" |
| The limits hold under concurrency: one session for each site, four on the server, ended sessions not counted, a failed start gives its place back | `m5c-exec-qa.test.ts`: "4. … ten opens at once on one site give one session", "opens at once on six sites give four; an ended session is not counted", "failed starts give their place back"; `apps/docker-executor/test/terminal-sessions.test.ts`: "takes the slot before the first await, so concurrent opens cannot pass the limit", "allows one session per site and four on the server, not counting ended ones", "gives the slot back when start fails"; `m5c-api-qa.integration.test.ts`: "point 4: … a second session on a site is refused also for another administrator, the fifth on the server too", "two opens at the same moment on one site give one session (three rounds)", "a session that ended by itself frees its place at the latest after one pass" |
| A session belongs to one site, and to one administrator | `m5c-exec-qa.test.ts`: "5. … on the simulator over IPC: another site's container, a stopped one and a gone one are NOT_FOUND", "on the real adapter the site comes from the container's label, not from the request"; `apps/docker-executor/test/terminal-docker.test.ts`: "refuses with NOT_FOUND a container that is missing, stopped or another site's, before any exec"; `apps/docker-executor/test/simulator-terminal.test.ts`: "refuses a missing, stopped or other site's container with NOT_FOUND, and gives the slot back"; `m5c-api-qa.integration.test.ts`: "point 5: … write, read and close answer the same 404 as a session that does not exist, and touch nothing"; `admin-terminal.integration.test.ts`: "answers 404 to another administrator and to a malformed session id" |
| Every end the executor decides, except `container_gone`, kills the shell as `33:33` (`executor_gone` and `not_started` are written by the API alone and run no kill) with only that session's mark; the reaper acts only where a shell is left | `m5c-exec-qa.test.ts`: "6. … %s: the kill runs as 33:33 with that session's mark and nothing else's" (closed, shell_exited, idle, time_limit, container_gone, each with a second session left alive); `terminal-docker.test.ts`: "creates /bin/sh as 33:33 with a TTY, the fixed size, the prompt and the session mark", "close runs the kill script as 33:33 with the session id and ends as closed", the six cases of why a stream ended, "inspects running site containers and runs the kill script only where an exec is left", "a failure on one container does not stop the pass and throws one coded fixed sentence" |
| Panel restart uses the fixed name only, never creates a container, and is `RESOURCE_LOCKED` while that component is being set up | `m5c-exec-qa.test.ts`: "7. … never creates a container: an absent one answers NOT_FOUND and no create or start is sent", "two restarts of one component at the same moment: one runs, the other is RESOURCE_LOCKED"; `panel-restart.test.ts`: "a missing container is NOT_FOUND, a daemon error INTERNAL_ERROR, and no Engine text leaks", "is RESOURCE_LOCKED while an ensure or apply of that component is in flight", "a second restart of the same component is RESOURCE_LOCKED, and an ensure waits for a running restart" |
| Nothing is kept: no output after the record is dropped (10 minutes), and no file is written. On the simulator this failed until the repair of defect D2 (R194 2.2, see the defects below) | `m5c-exec-qa.test.ts`: "8. … ten minutes after its end the record is dropped and the manager holds none of its output (fake timers)" (failed on D2, passes since the repair), "on the real adapter a session writes no file, and its dropped record keeps no output"; `simulator-terminal.test.ts`: "a session ended by %s lets go of its output sink" (exit, idle, container_gone, close); `terminal-sessions.test.ts`: "keeps an ended record ten minutes, and a close on it returns its reason and drops it" |
| R195 2.1, R196 1.2: a kill that fails is noticed and tried again at each close (the API's pass asks one every 30 seconds) until it works or the ten minutes of the ended record are over, then one log line with only the event and a fixed code; this holds also for the kill after the shell ended by itself (Ctrl-D, `exit`). An ended record never holds the site's place or one of the four | `terminal-docker.test.ts`: "the kill says whether it worked" > "true when the kill exec exits 0", "false when the kill exec exits 1", "false when the kill exec's start is refused, and true on the next try", "true when the container is gone: nothing is left to kill"; `terminal-sessions.test.ts`: "TerminalSessions when a kill does not work" > "keeps the record, kills again on the next close, and frees the site and the slot meanwhile", "drops the record after the kept time and logs one line with only the event and a code", "a shell that exited by itself: its kill failed, the first close keeps the record, the second kills again and drops it", "a shell that exited by itself and is never killed: one log line after the kept time". All on fakes and on the mock daemon, never on a real Engine |
| R192 3: Restart is on every site row of Health; for a site wanted stopped the dialog warns that it starts again | `apps/web/test/admin-restart.test.ts`: "Restart on panel rows that can restart and on every site row; Terminal only on running or degraded", "restartWarning: the target's own warning, plus the stopped sentence for a site wanted stopped"; `m5c-web-qa.test.ts`: "6. … the Health page gives every site row its wanted state, so a stopped site's dialog warns that it starts again", "each of the six warnings says in both languages what stops and for whom; a stopped site adds R192 2.3" |
| R192 4 (A.4): a Restart of a site wanted stopped makes it wanted running | `apps/api/test/managed-sites.integration.test.ts`: "a Restart of a site wanted stopped makes it wanted running"; `m5c-api-qa.integration.test.ts`: "point 8: … Stop, Start, the administrator's Restart, Stop, and Restart again: every view and the wanted state follow" |
| Restart of a container that is gone creates it again (handed on by R190), with the volumes of the stored revision, only for a site whose set-up succeeded and for which nobody ever asked a delete (R195 1.2) | `admin-restart.integration.test.ts`: "A.5 a container that is gone is created again only after a set-up that succeeded; Stop on it creates nothing"; `m5c-api-qa.integration.test.ts`: "point 8: Restart of a site whose provisioning failed … creates no container"; `apps/api/test/admin-health.integration.test.ts`: "R190 1.2: the administrator's Restart creates a missing container again"; `apps/api/test/m5c-review.integration.test.ts`: "1.2 Restart after a delete that failed halfway" > "creates no container and fails as for a site that was never set up", "1.5 a container that Restart rebuilt" > "has the volumes of the stored revision" |
| R195 1.1, R196 1.1: a Stop that fails for sure (any failure that is not `OPERATION_AMBIGUOUS`, while the operation was still queued or processing) makes the site wanted running again in the transaction that fails the operation; a Stop left in doubt stays wanted stopped until the recovery pass, which makes it wanted running again only when it sees the container running, and leaves it wanted stopped when it sees it stopped (the operation succeeds) or does not find it | `m5c-review.integration.test.ts`: "1.1 a Stop that failed" > "fails for sure: the wanted state goes back to running and every answer says running", "is ambiguous: the wanted state stays stopped", "in doubt, recovery sees it running: failed, the wanted state goes back to running", "in doubt, recovery sees it stopped: succeeded, the wanted state stays stopped", "in doubt, recovery finds no container: failed, the wanted state stays stopped", "works: the site is stopped as before" |
| R195 1.3: the change of owner of a stopped site whose stop after the redeploy fails for sure leaves the site wanted running; the operation fails, and Try again finishes the move | `m5c-review.integration.test.ts`: "1.3 owner change of a stopped site whose stop after the redeploy fails" > "leaves the wanted state running and the operation failed; Try again finishes the move" |
| R195 1.4: the `admin.site.restart` row is written in the transaction that queues the restart, once; a replay of the same key writes none, and a failed insert queues nothing | `m5c-review.integration.test.ts`: "1.4 the audit row of a site restart" > "is written once with the operation, not again on a replay, and not at all without the operation" |
| A panel restart: request row before the run, end row after; `component_down` is not raised while it runs | `admin-restart.integration.test.ts`: "A.6 answers 202 with the request row before any run, restarts after the delay, and writes the end row", "A.6 an executor error, a request older than 60 s and an expired lease each end failed with the end row", "A.6 the runtime disabled answers 422", "A.7 component_down is not raised while a restart runs or for a look older than its end, and comes back on a newer look" |
| Terminal output is shown as text on the page | `m5c-web-qa.test.ts`: "1. the text rule on what a real shell printed" (three cases, on a captured fixture), "2. … markup, attributes and entities in output are rendered as text", "no M5c file of apps/web/src builds markup from strings", "a line of 100 000 characters and 5000 lines keep the rule, …"; `admin-terminal.test.ts`: the "terminal-text feed" cases, "output renders only as text: finished lines in a polite log, the line in progress outside it" |
| R195 3.1: the characters that change the direction of text (U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C) are dropped from the output | `admin-terminal.test.ts`: "drops the characters that change text direction, also at the edge of a read; Arabic and Hebrew stay" (runs the code) |
| R195 3.2: a page shown again from the browser's back/forward cache reloads itself | `admin-terminal.test.ts`: "a page shown again from the back/forward cache reloads itself; the listener leaves with pagehide's" (runs the page's effect against a stub `window`, not in a browser) |
| R195 3.3: an empty read changes nothing; the output box follows new text only when it was at the end, and can be reached and scrolled from the keyboard | `admin-terminal.test.ts`: "a read that adds nothing returns the same object", "the output follows new text only when it was at the end; the box is named and reachable from the keyboard" (both run the code; the second calls the box's scroll handler on a fake box, no browser scroll) |
| R195 3.4: the Restart dialog cannot be closed while the restart is being sent; after it is sent the button keeps focus and opens nothing | `admin-restart.test.ts`: "the dialog cannot be closed while the restart is being sent, and can after a refusal", "after 202 the trigger keeps focus but opens nothing; idle it opens the dialog" (both run the code; that the dialog library skips opening after `preventDefault`, and where focus goes, were read in its source, not run) |
| R193 2 (D1): a read the browser never gets an answer to counts as lost after 40 s | `m5c-web-qa.test.ts`: "5. … a read the browser never gets an answer to counts as lost after 40 s" (failed before the repair by `fix-web`, passes since), "a read that hits the BFF limit after 40 s ends as lost at once, …"; `admin-terminal.test.ts`: "each read's own 40 s limit" (three cases) |
| R194 2.3 (D3, see the defects below): a session the page counts as lost gets the same best-effort close as leaving the page | `admin-terminal.test.ts`: "a lost session gets the same best-effort close as leaving, then the end shows" (a check of the source text, not a run) |
| Nothing from the address bar reaches the API unchecked | `admin-terminal.test.ts`: "refuses a missing or wrong CSRF token, a foreign origin and no session before the upstream", "refuses a path segment of a wrong shape before the upstream"; `admin-restart.test.ts`: "site restart refuses no key, a wrong CSRF token, another origin, no session and a bad segment, without calling upstream", "panel restart accepts only a panel container; anything else is 400 with no upstream call"; `m5c-web-qa.test.ts`: "4. nothing from the address reaches upstream unchecked" |
| Every sentence works in both languages, names a next step, and names only buttons and pages the panel has | `m5c-web-qa.test.ts`: "7. … after filling placeholders: no brace, no key name, no undefined, in both languages", "the Italian text differs from the English one except for the key names Ctrl-C and Ctrl-D", "every refusal and every way a session ends names what to do next", "the sentences name only buttons and pages the panel has", "the customer's sentence holds no forbidden word and no admin text of M5c is in a customer section"; `admin-terminal.test.ts`: "terminalErrorText has the catalog sentence for every refusal, in both languages", "endText has a sentence for every end reason and for a lost page"; `admin-restart.test.ts`: "restartErrorText: a sentence with a next step for every refusal, in en and it" |
| Accessibility in the markup | `m5c-web-qa.test.ts`: "8. … the code field and the command line have a label and their hint tied; errors are alerts; every button has a name", "Restart and Cancel are named buttons; the follow-up is a status", "a disabled Change version has its reason on screen as text"; `admin-restart.test.ts`: "the form: title, warning as description, a required reason of at most 500 with its hint tied" |
| The customer's side did not change, except Change version | `m5c-web-qa.test.ts`: "10. … the customer's Start, Stop and Restart send the requests they sent before"; `admin-restart.test.ts`: "Change version shows why it is disabled while the site is stopped" |
| The screen, the BFF routes, the API and the contract fit together | `m5c-web-qa.test.ts`: "9. … every address the pages request has a route file exporting that method, and no other address is requested", "every BFF route forwards to a path and method an API controller serves", "the fields the pages read exist in the contract" (checks over the source text, not a run against the API) |
| D24: the real-Docker script | See "Accept script on a real Docker Engine (D24)" below |

### Test runs

This report's author ran each file alone with `timeout 540 corepack pnpm exec vitest run <file>`,
one after another, on 2026-11-17, between 03:13 and 03:19 UTC (Node 26.13.1), on the tree with the
repairs of R195 and R196. The time is when the run began. The counts are what vitest printed. No
total is given for the whole suite (the lead's whole checks are below).

| File | Written by | Result |
|---|---|---|
| `apps/docker-executor/test/terminal-ipc.test.ts` | engineers | 4 passed (4), 03:13:21 |
| `apps/docker-executor/test/terminal-sessions.test.ts` | engineers | 25 passed (25), 03:13:22 |
| `apps/docker-executor/test/simulator-terminal.test.ts` | engineers | 17 passed (17), 03:13:22 |
| `apps/docker-executor/test/terminal-docker.test.ts` | engineers | 15 passed (15), 03:13:23 |
| `apps/docker-executor/test/panel-restart.test.ts` | engineers | 5 passed (5), 03:13:30 |
| `apps/docker-executor/test/panel-containers-qa.test.ts` | QA (executor, M5b) | 48 passed (48), 03:13:31 |
| `packages/contracts/test/admin-terminal.test.ts` | engineers | 10 passed (10), 03:13:32 |
| `packages/contracts/test/contracts.test.ts` | engineers | 46 passed (46), 03:13:32 |
| `packages/executor-contracts/test/executor-contracts.test.ts` | engineers | 13 passed (13), 03:13:33 |
| `packages/database/test/admin-terminal-repository.test.ts` | engineers | 6 passed (6), 03:13:34 |
| `packages/database/test/phase2-database.test.ts` | engineers | 15 passed (15), 03:13:41 |
| `apps/api/test/admin-restart.integration.test.ts` | engineers | 10 passed (10), 03:13:44 |
| `apps/api/test/admin-terminal.integration.test.ts` | engineers | 15 passed (15), 03:14:03 |
| `apps/api/test/admin-route-guard.integration.test.ts` | engineers | 4 passed (4), 03:14:28 |
| `apps/api/test/admin-sites.integration.test.ts` | engineers | 18 passed (18), 03:14:33 |
| `apps/api/test/managed-sites.integration.test.ts` | engineers | 37 passed (37), 03:15:06 |
| `apps/api/test/admin-health.integration.test.ts` | engineers | 25 passed (25), 03:16:09 |
| `apps/web/test/admin-restart.test.ts` | engineers | 18 passed (18), 03:16:49 |
| `apps/web/test/admin-terminal.test.ts` | engineers | 46 passed (46), 03:16:50 |
| `apps/web/test/admin-health.test.ts` | engineers | 15 passed (15), 03:16:51 |
| `apps/web/test/m5b-web-qa.test.ts` | QA (web, M5b) | 36 passed (36), 03:16:52 |
| `apps/web/test/m5c-web-qa.test.ts` | QA (web) | 82 passed (82), 03:16:53 |
| `apps/docker-executor/test/m5c-exec-qa.test.ts` | QA (executor) | 28 passed (28), 03:16:54; test 8 (D2) failed in the first run of this report (three runs at 01:34:55, 01:37:14 and 01:37:43) and passes since the repair |
| `apps/api/test/m5c-api-qa.integration.test.ts` | QA (api) | 18 passed (18), 03:17:23; no test failed and none was left unfinished |
| `apps/api/test/m5c-review.integration.test.ts` | engineers (R195, R196) | 10 passed (10), 03:18:01 |

`m5c-web-qa.test.ts` holds the proof of D1 (R193 2). It passes since the repair by `fix-web`.
In the first run of this report, `eslint` on `m5c-exec-qa.test.ts` and `corepack pnpm --filter
@hosting-panel/docker-executor run typecheck` both exited 0; this author did not run them again
(the lead's whole checks below include lint and typecheck).

### Accept script on a real Docker Engine (D24): reported by exec-docker, not run by this report's author

`exec-docker` (eng-c12-b) wrote `infra/linux/accept-m5-terminal.mjs` and ran it twice in a row
against a real Docker Engine. Their report gives the last lines of the last run and says the run
before it printed the same:

```
PASS 1-setup
PASS 2-a1-open-size-id
PASS 3-a2-ctrl-c
PASS 4-a3-close-ends-children
PASS 5-a4-idle
PASS 6-a5-records
PASS 6b-ctrl-d-shell_exited
PASS 7-a6-restart-ends-container_gone
PASS 8-b-restart-by-name
PASS 9-nothing-left
RESULT 10/10 passed
```

They counted what was left after both runs with `docker ps -a`, `docker volume ls` and
`docker network ls`, each filtered on `name=hp_swarmtest_m5t`: 0, 0 and 0. Their first run failed
at step 7: a restart ended the session as `shell_exited`. They fixed this with the one-second wait
of the end rule, which R193 1.4 accepts as built with its named limit. These results are theirs.
This report's author did not repeat them, and no Docker was used for this report. These scripts
have no API and no database, so the audit rows themselves are proven by the API's tests.

The repair of review round 1 (R195 2.2) gave the script one more step, so it now has eleven:
`4b-close-spares-web-server-workers`. Before the close of step 4 it lists the ids of the web
server's worker processes in container A, which run as the same user as the shell (at least two
must be listed); after the close it checks that the same ids still run. It shows that closing a
session kills only that session's processes, not the web server's. The engineers ran the script
themselves after their repairs and reported: `r1-exec` twice, 11 of 11 each time; `r2-fix` twice,
11 of 11 each time; nothing named `hp_swarmtest_m5t` left behind. Those results are theirs.

### The lead's runs of cycle 12

All on 2026-11-17, Node 26.13.1. "Tree" is the id of a snapshot of the uncommitted working tree,
the run folder `.herdr-swarm` left out. This report's author did not run them.

The whole checks (`corepack pnpm run build`, `lint`, `typecheck`, `test`):
- run `c12d`, on the tree the three reviewers of round 1 read (`514adfe`): all four exit 0; 182
  test files, 3167 tests passed, 43 skipped, none failed.
- run `c12e`, on the tree after the repair of round 1 (`15699e7`): build, typecheck and test exit
  0; 183 test files, 3186 passed, 43 skipped, none failed. `lint` first failed on one file only, a
  reviewer's scratch probe under `.herdr-swarm` (not part of the repository and never committed);
  with that file set aside, `lint` exits 0.
- run `c12f`, on the tree after the repair of round 2 (`1f8cbbd`): build, typecheck and test exit
  0; 183 test files, 3191 passed, 43 skipped, none failed. `lint` again first failed only on a
  reviewer's scratch probe under `.herdr-swarm`, and exits 0 with it set aside.

The ten real-Docker scripts (`accept-m1-files`, `accept-m1-sftp`, `accept-m2-databases`,
`accept-m2-phpmyadmin`, `accept-m3-backups`, `accept-m3-panel`, `accept-m4-wordpress`,
`accept-m4-import`, `accept-m5-health`, `accept-m5-terminal`), on throw-away containers only, with
what was left behind counted afterwards:
- run `c12c`, before the repairs of the test phase and of the two review rounds: all ten passed
  (17/17, 19/19, 17/17, 24/24, 28/28, 13/13, 12/12, 13/13, 6/6, and the terminal script 10/10, which
  had ten steps then); containers, volumes, networks and shared-memory files left behind: 0, 0, 0, 0.
- run `c12e`, on the tree after the repair of round 1 (`15699e7`): all ten passed (17/17, 19/19,
  17/17, 24/24, 28/28, 13/13, 12/12, 13/13, 6/6, and the terminal script 11/11 with its new step);
  left behind: 0, 0, 0, 0.
- run `c12f`, on the tree after the repair of round 2 (`1f8cbbd`): the summary
  `.herdr-swarm/swarm-1114-132739/scratch/c12f-accept-summary.log` reads, word for word:

```
v26.13.1
m1-files exit=0 fail=0 | accept-m1-files: 17/17 passed in 12.5s
m1-sftp exit=0 fail=0 | accept-m1-sftp: 19/19 passed in 35.4s
m2-databases exit=0 fail=0 | accept-m2-databases: 17/17 passed in 19.0s
m2-phpmyadmin exit=0 fail=0 | accept-m2-phpmyadmin: 24/24 passed in 54.5s
m3-backups exit=0 fail=0 | accept-m3-backups: 28/28 passed in 231.3s
m3-panel exit=0 fail=0 | RESULT 13/13 passed in 79s
m4-wordpress exit=0 fail=0 | 12/12 passed in 170.2 s
m4-import exit=0 fail=0 | 13/13 passed in 130.0 s
m5-health exit=0 fail=0 | RESULT 6/6 passed
m5-terminal exit=0 fail=0 | RESULT 11/11 passed
left-containers=0
left-volumes=0
left-networks=0
left-shm=0
end-accept
```

### Review round 1, repaired by R195

Three reviewers (`rev-power`, `rev-term`, `rev-web`) read the tree `514adfe`. Their reports give one
medium and nine low findings; nothing high, no way to reach what is not one's
own, no leak of what is typed or printed. R195 decided them. Repaired in phase `fix-c12-r1` by three
engineers (`r1-api`, `r1-exec`, `r1-web`), each on files of their own; the tests are in the
properties table above:
- **A Stop that failed left the site shown as stopped while it served** (medium, `rev-power`): the
  wanted state `stopped` was saved when the Stop was queued, and nothing put it back when the stop
  failed. The customer's page then hid Stop, and Health raised nothing. A stop that fails for sure
  now makes the site wanted running again (R195 1.1). Round 2 found that the sentence of R195 1.1
  about a Stop left in doubt was wrong: see below.
- **Restart rebuilt the container of a site whose delete failed halfway** (low, `rev-power`): it no
  longer rebuilds once a delete was asked for the site (R195 1.2).
- **The change of owner of a stopped site whose stop failed left it running while wanted stopped**
  (low, `rev-power`): the site is now wanted running, and the operation fails (R195 1.3).
- **The site restart's audit row was written after the restart was queued** (low, `rev-power`): a
  database failure could leave a restart with no row. The row is now written in the transaction
  that queues it, and a replay of the same key writes none (R195 1.4). This replaces what R192 A1
  accepted.
- **Tests the reviewer missed** (R195 1.5): a failed Stop; a rebuilt container has the volumes of
  the stored revision; point 8 of `m5c-api-qa.integration.test.ts` now asserts `202` instead of
  skipping.
- **A kill that failed was not noticed** (low, `rev-term`): the shell could keep running while its
  row said the session had ended. The kill now says whether it worked, and a record whose kill
  failed is kept and the kill tried again (R195 2.1). The real-Docker script gained step 4b
  (R195 2.2).
- **The terminal page** (four low, `rev-web`): direction characters passed the output rule; a page
  restored from the back/forward cache looked open and swallowed a typed line; the output box
  jumped to the end on every read and could not be scrolled from the keyboard; the Restart dialog
  lost focus after it was confirmed and could be closed while it was sending (R195 3.1 to 3.4).
- **This report** (low, `rev-web`): it still said that D2 was open and its test failed. Repaired by
  this update (R195 4).

Accepted (R195 5), with the reason: under a flood of output memory stays bounded (256 KiB per
session, four sessions), but the copy per chunk was not measured; the reaper cannot slow the
executor's start, because a site's container has no health check; after a write that "could not be
sent" the page never sends the line again by itself, so a line runs twice only if the administrator
presses Enter again after the first arrived late (an executor stalled for more than 8 seconds); a
cursor past the end answers `503`, not `400`, and the page never sends one; "after a server restart
the sites come back by themselves" stays as read in the code (see "Not proven"); "a lost session
sends a close" stays proven on the source text. R194 4.1 to 4.3 were answered: no free text of the
Docker Engine reaches `errorMessage`; a break-glass token still needs that administrator's fresh
code and lives five minutes; two opens at once are serialised by the table lock as PostgreSQL runs
it (read, not run). Handed to M6 (older than this cycle, unconfirmed): an API-internal error text
stored as the error of a generic-service operation; the mail upgrade reading wanted-running sites
outside its transaction; a restore cut by a restart of the shared database.

### Review round 2, repaired by R196

One reviewer (`rev-r2`) read the patch between `514adfe` and `15699e7`, the repair of round 1, and
found one medium and two low findings. R195 1.2 to 1.5, 2.2 and 3.1 to 3.4 were found correct.
Repaired in phase `fix-c12-r2` by one engineer (`r2-fix`):
- **A Stop left in doubt that the recovery pass then ended as failed kept the site wanted stopped
  while it served** (medium). R195 1.1 had said that the drift pass settles a Stop in doubt; R196
  withdrew that sentence, because the drift pass only looks. The pass that ends an operation left in
  doubt is the recovery pass. When it ends a Stop as failed and has just seen the container running,
  it now makes the site wanted running again in the same transaction (R196 1.1). Nothing changes
  when the container was not found, when the executor is switched off, or when the read fails (the
  operation stays in doubt for the next pass). The test of round 1 for a Stop in doubt passed with
  and without that repair; the new tests run the recovery pass.
- **The kill after the shell ended by itself was run once and never looked at** (low): when the
  shell ends by itself (Ctrl-D, `exit`), the session manager now runs that kill, so it is tried
  again and logged like the others (R196 1.2).

Accepted (R196 2), with the reason:
- A stop the Docker Engine does not answer within 30 seconds counts as failed for sure (low): the
  site becomes wanted running; if the Engine finishes the stop afterwards, the site is down while the
  pages say it runs. Health shows it down, and Stop again settles it. The repair would change how the
  executor reports a time-out for every caller; it is on the M6 list.
- Restart and Start never rebuild the container of a site somebody asked to delete, also when that
  delete failed before it removed anything: this is what R195 1.2 ruled. The way out is to run the
  delete again, or to restore the site from a backup (ADR 0027).
- The kill of a session closed while it was still starting is tried once.
- Unconfirmed: the generic service route writes `stopped` after its queueing commit (already on the
  M6 list); in the change of owner a database error in the failure branch hides the stop's own error
  (the operation fails either way); the new web tests reach into React's internals (see "Not
  proven").

### Review round 3 and ruling R197

One reviewer (`rev-r3`) read the code repair of round 2 (the patch between `15699e7` and
`1f8cbbd`) and the documents brought up to date after it (tree `4cc3c43`). It found nothing of
medium weight or more and two low findings, and it found R196 1.1 and 1.2 correct. It ran no test.
This was the third and last round: no code changed after it, so the lead's runs on the tree
`1f8cbbd` are the runs of the code this part ships.
- **The recovery pass reads the container once** (low, accepted as a named limit, R197 1): when the
  executor dies in the middle of a stop and is back within the 10 seconds the stop gives the
  container, the recovery pass can still see the container running. It then ends the Stop as failed
  and makes the site wanted running (R196 1.1); Docker finishes the stop afterwards, and the site
  is down while the pages say it runs. The harm and the way out are those of the 30-second limit of
  R196 2: Health shows it down, and Stop again settles it. Before R196 1.1 this rare case came out
  right and the common one (the container keeps running) came out wrong. The repair, a second read
  after those 10 seconds, is on the M6 list. ADR 0027 names it as limit 32.
- **No page shows the `terminal_kill_failed` line** (low, repaired in the documents, R197 2): the
  line is only in the executor's journal on the host (`journalctl -u hp-docker-executor`). The
  Logs page shows containers (the panel's five and each site's), not the services of the host.
  Limit 25 of ADR 0027 now says where the line is.

Corrected by the lead after the round, in ADR 0027: the sentence on the kill script said that every
end except `container_gone` runs it. `executor_gone` and `not_started` are written by the API
alone, when the executor does not hold the session, and no script runs for those two ends.

Accepted (R197 3): a container paused outside the panel reads as running, so the recovery pass
would make its site wanted running. The mapping is older than this part.

This section, limits 25 and 32 of ADR 0027 and the corrected sentence were written by the lead
after the round. No reviewer read them.

### Defects found by these runs, repaired by R194

| Defect | What the design says | What the code did | Where | Weight | Test |
|---|---|---|---|---|---|
| D2: the simulator kept a dropped session's output | What is typed and printed goes to the administrator's screen and nowhere else; an ended record is kept ten minutes (`TERMINAL_ENDED_KEPT_MS`) and then dropped | `openTerminal` stored each session's sink in `terminalSinks`, and only `closeTerminal` and `forgetTerminalSessions` deleted from that map. A record that ended by itself (`shell_exited`, `idle`, `time_limit`, `container_gone`) left its sink behind when it was dropped, and with it the session's output (up to 256 KiB) for the life of the simulator. Only the local-simulator runtime was touched; the real adapter keeps no such map | `apps/docker-executor/src/simulator-adapter.ts` (`openTerminal`) | low | `m5c-exec-qa.test.ts` "8. nothing is kept > ten minutes after its end the record is dropped and the manager holds none of its output (fake timers)": failed, left failing as the proof; repaired in phase `fix-c12-qa` (`openTerminal` lets go of the sink however the session ends); passes. `simulator-terminal.test.ts` "a session ended by %s lets go of its output sink" was added with the repair |
| D3: after "lost" the page sent no close | A session the page leaves is closed | The server could hold the session up to 60 seconds more and refuse the administrator's next opening on that site as busy | `apps/web/src/components/admin/terminal-console.tsx` | low | `admin-terminal.test.ts` "a lost session gets the same best-effort close as leaving, then the end shows" (a check of the source text); found by `fix-web`, repaired in phase `fix-c12-qa` (the page sends the same best-effort close it sends when it is left); passes |

### Not proven

- What R192 names:
  - Docker's own start of the site containers at the boot of the host was read in the code, not
    run (the daemon is shared and was not restarted; R192 6).
  - A generic service with `secretRefs` (not a managed site) does not come back after a host
    restart, because the tmpfs secrets folder is empty. This was not repaired in M5c and is handed
    to M6 (R192 3).
- The named limits of R192 and ADR 0027, among them:
  - full-screen programs do not work in the terminal;
  - a process that both leaves its session and removes its session mark outlives a close until
    the container restarts.
- R193 1.4: the reaper was proven on the mock daemon only. Its call at the executor's start and the
  25-second Engine time limit of a restart were not tested.
- R191 1.1: no test asserts that the dropped clause is absent (see "Review round 3 and ruling
  R191").
- Nobody opened the Terminal page, the Restart dialog or Health in a browser. Every web property
  above is proven on server-rendered markup and on route handlers called in Node. Of the repairs
  of round 1 these were read, not run in a browser: the reload of a page restored from the
  back/forward cache, the output box that stays where it was scrolled, where focus goes after the
  Restart dialog, and that the dialog library opens nothing after `preventDefault`.
- The new web tests of round 1 reach into React's internals (they depend on the order of the
  page's state and ref calls): they can break on a React upgrade while the page still works.
- "A lost session sends a close" is proven on the source text only (R195 5).
- No screen reader was used. Accessibility is proven only as roles, labels and names in the markup.
- A kill that fails was made to fail on fakes and on the mock daemon only, never on a real Docker
  Engine (there is no way to make an exec fail there on purpose).
- Under a flood of output, the copy of the kept output at each chunk was not measured (R195 5).
- Row locks were not run on a real PostgreSQL: the API's tests run on PGlite, which runs one query
  at a time; two opens at once were read as PostgreSQL would run them (R195 5).
- A stop the Docker Engine does not answer within 30 seconds counts as failed for sure; the site may
  stop afterwards while the pages say it runs (R196 2). No test makes the Engine that slow.
- A Stop cut by the executor's death that Docker finishes after the recovery pass has looked (R197
  1): no test covers it.
- A restore of a site whose delete failed, the way out limit 31 of ADR 0027 names, was read in the
  code, not run (R197 3).
- The real Docker Engine was touched only by the real-Docker scripts: `exec-docker`'s and the
  engineers' runs of the terminal script, and the lead's runs of the ten scripts above. Every other
  run in this part used the executor's simulator or a mocked Engine.

## M5d: the host

### Acceptance properties (M5D-FRAME D22, D27, D28; rulings R198 and R199)

| Property | Proven by |
|---|---|
| Acceptance 2 of M5, first part, in the frame's words: "every route is `infrastructure_admin` only (customer gets `403` + audit)". D22: every M5d route is under `/v1/admin/…` behind `requireServerAdmin` | `apps/api/test/admin-route-guard.integration.test.ts`: "the router holds at least 40 administrator, hosts and allocations routes", "a member and an owner get 403 PERMISSION_DENIED and exactly one denied audit row naming them, and nothing changes", "without credentials every route answers 401 except the pinned open ones"; `apps/api/test/admin-firewall.integration.test.ts`: "a customer gets 403 and one denied row on each of the five routes, and nothing changes"; `apps/api/test/admin-updates.integration.test.ts`: "a customer gets 403 and a denied row on all eight routes, and nothing is queued"; `apps/api/test/admin-host-services.integration.test.ts`: "refuses an unknown service, a missing reason and a disabled runtime before anything is queued; a customer gets 403 and a denied row"; `apps/api/test/m5d-api-qa.integration.test.ts` (QA): "P1: every M5d route and a journal source: 401 without a session, 403 plus one denied row for an owner and a support user, even with a hostile body; nothing reaches the host" |
| The web side of the same: every M5d BFF route answers `401` without a session and `403` without the CSRF token or from another origin, and forwards nothing; a customer who types `/admin/firewall` or `/admin/updates` is sent away | `apps/web/test/m5d-web-qa.test.ts` (QA): "%s: 401 without a session and nothing is forwarded" (12 routes), "%s: 403 without the CSRF token, with a wrong one or from another origin" (11 routes), "a customer who types the address of a new page is sent away by the admin layout" |
| Acceptance 2 of M5, second part: "firewall rejects rules that would close 22/80/443 or the panel" | `packages/contracts/test/admin-firewall.test.ts`: "opens no port the panel or a database needs"; `apps/api/test/firewall.unit.test.ts`: "an unknown port name is refused and never reaches the agent"; `m5d-api-qa.integration.test.ts`: "P2: names for 22/80/443/3000, a number, capitals and a slash give 400 unknown_port and reach no agent; the safe list holds none of the closed ports", "P2: over open, block, block a network, unblock and close, every list the agent received holds only safe ports and canonical addresses"; `apps/host-agent/test/m5d-host-qa.test.ts` (QA): "80/443/22 are fixed rules, the opened set only accepts, 3000 only from the bridges, and the only drops are the designed ones", "prerouting accepts 22 before any drop, and the blocked sets are used only to drop", "a blocked address can still reach exactly 22, ND, and the local and bridge interfaces"; `m5d-web-qa.test.ts`: "%s: a parameter outside its closed form is 400 and nothing is forwarded" (port names `ssh`, `http`, `https`, `panel`, `22`, `8080` and others); on a real kernel, steps `04-static-ports-v4`, `05-static-ports-v6` and `11-block-v6-network-keeps-nd-and-22` of `qa-host`'s script (below) |
| The block that would lock the administrator out is refused | `firewall.unit.test.ts`: "blocks and unblocks: canonical form, families, refusals with reasons, 404 for an unknown id"; `admin-firewall.integration.test.ts`: "block and unblock: 201 then 200, every refusal with its reason, 404 for an unknown or malformed id" (this case is intermittent, see "Test runs"); `m5d-web-qa.test.ts`: "the block route sets the client address only from an x-real-ip that is one whole address, and over the browser's", "%s: forwards once, only to its own path and method, and never a browser-sent client address". R198 3.2: this check is advice, not a boundary |
| Acceptance 2 of M5, third part: "host agent still has no `sh -c` / shell interpolation" | `apps/host-agent/test/m5d-host-qa.test.ts` (QA): "src has no subdirectory, and only linux-adapter.ts imports child_process, and only execFile", "one runner: execFileAsync is called once, with shell:false, and every program path is one of the allowed seven", "refuses a program outside the seven before execFile", "over IPC, hostile bodies never change the path or the program nft gets", and the block "P1 no shell in the root units"; `apps/host-agent/test/host-m5d.test.ts`: "starts an accepted form with execFile, no shell, the fixed environment and the input on stdin" and the block "closed argument forms (R198 2.1)" |
| D22: every change writes an audit row; a job has one row at the request and one at its end; no row holds a journal line, a package list or what the updater printed | `admin-host-services.integration.test.ts`: "answers 202, writes one request row with the reason, and the worker records one .end row"; `apps/api/test/host-jobs.test.ts`: "settleHostJob twice writes one end row: whichever path comes second writes nothing"; `admin-firewall.integration.test.ts`: "view, open and close: 200, the DTO parses, one audit row per change, none for a port already in its state"; `m5d-api-qa.integration.test.ts`: "P4: markers in journal lines, package names, service states, failed jobs and lost polls never reach a record; errors carry fixed sentences" |
| D27, firewall: a port outside the safe list never reaches the agent; no input can produce an nft program naming another table, chain or rule; the lists are sent again after "apply base rules" and at start; "not in force" is shown | `firewall.unit.test.ts` and `m5d-api-qa.integration.test.ts` as above; `m5d-host-qa.test.ts`: the block "P2 every nft call is one of four argument lists"; `admin-firewall.integration.test.ts`: "after the shipped apply of the base rules and one worker pass the host holds the stored lists again", "rows stored before the API starts reach the host at start"; `apps/web/test/admin-firewall.test.ts`: "not in force: the badge on the entry and the banner with Apply again"; `m5d-web-qa.test.ts`: "stored, not in force, for a port and for a block: the words on the entry and Apply again" |
| D27, jobs: a request writes exactly the fixed file name; an unknown job is refused before any file; the end is recorded once, also across a restart of the API | `m5d-host-qa.test.ts`: "%s writes one empty 0600 file with its fixed name and nothing else", "an existing trigger answers RESOURCE_LOCKED and is not overwritten", "a dangling link at the trigger path answers RESOURCE_LOCKED and its target is never created"; `host-m5d.test.ts`: "refuses a job outside the list before any file or program"; `host-jobs.test.ts`: "settleHostJob twice writes one end row: whichever path comes second writes nothing", "recovery is pending while the job runs or the agent is away, and settles once its run has ended"; `admin-host-services.integration.test.ts`: "a stale request ends OPERATION_INTERRUPTED, not_started, and requests nothing"; `apps/api/test/host-job-end-across-restart.integration.test.ts` (QA, `qa-api`): "the first app stops while the job runs; the job ends; the second app settles it in its recovery pass, once, and the first app's late look writes nothing", "two concurrent settleHostJob calls write one end row; the operation keeps the winner's result" (two apps over one database in one process, not a restart of a real service) |
| D27, journals and packages: hostile program output reaches no answer and no record | `m5d-host-qa.test.ts`: "no thrown error, no IPC answer and no console or stdio write holds program output"; `host-m5d.test.ts`: "answers 422 NOT_SUPPORTED with a fixed sentence, never the text of a program"; `m5d-api-qa.integration.test.ts`: "P4: …" as above |
| D28: the firewall on a real kernel | `infra/linux/accept-m5-firewall.mjs`, written and run by `qa-host` (see below); not run by this report's author |
| R198 1.5: no page shows an image name | `m5d-web-qa.test.ts`: "no page shows an image name (R198 1.5): the contract carries none and the Updates page writes none"; `m5d-api-qa.integration.test.ts`: "P3: no answer of any M5d route holds an image name, tag, digest, host path or raw unit property" |
| R198 1.7: a stopped site shows its sentence and no Update button | `apps/web/test/admin-updates.test.ts` (the case on sites with stopped and the "more" line); `m5d-api-qa.integration.test.ts`: "P12: image-update changes one site only; unknown 404, current and stopped 400; a customer cannot call it nor read the row, but sees the deploy without an image name" |
| R198 1.8: the dialog before a block names the address and says that the server and the sites stop getting answers from it | `m5d-web-qa.test.ts`: "the block dialog names the address and says what a block costs (R198 1.8); the form alone sends nothing" (English and Italian) |
| R198 2.1: a closed argument form is the whole argument list | `host-m5d.test.ts`: the block "closed argument forms (R198 2.1)"; `m5d-host-qa.test.ts`: the block "P2 closed argument forms through the real runner (execFile is a spy)" |
| R198 2.4: a stale trigger file does not run later | `host-m5d.test.ts`: "removes a stale trigger file and answers NOT_SUPPORTED when the path unit is not active (R198 2.4)"; `m5d-host-qa.test.ts`: "a stale trigger with no active path unit is removed and nothing else is touched (R198 2.4)" |
| R198 2.5: "belongs to this request" compares whole seconds | `host-jobs.test.ts`: "R198 2.5: a job started in the same whole second as its operation belongs to it"; `admin-host-services.integration.test.ts`: "R198 2.5: a run the simulator dates to the whole second of an operation started at .900 belongs to it" |
| No self-lockout on the page: closing a port asks first; with base rules absent or outdated every change control is disabled, and the page offers the apply only when the server has its host row (without one it says the server is not registered and offers no button); on a server installed with `--skip-firewall` (base rules `unmanaged`) it says the panel does not manage the firewall, offers no apply and no change control; the sentences of the apply say that only 22, 80, 443 and the ports opened on the page stay open and warn about SSH on another port; a failed read shows its sentence, not an empty list | `m5d-web-qa.test.ts`: "closing a port asks first and sends nothing; opening sends at once; the dialog names the port", "base rules absent or outdated: every change control is disabled and the page says what to do, with the button that does it", "base rules absent on a server without a host row: the sentence asks to apply them, so the page must offer a way", "R202: the base rules' sentences name 22, 80 and 443 and warn about SSH on another port; unmanaged says how to hand over", "disabled and a failed read: their one sentence, no control and no empty list"; `apps/web/test/admin-firewall.test.ts`: "%s: unmanaged shows its sentence, no apply and no enabled change control" |
| Every timed action ends in words; a 401 does not loop for ever; a job running when the page opens is followed again; the page reloads after the panel's own update | `m5d-web-qa.test.ts`: "a follow that gets 401 stops at the first one and ends signed out", "reads that fail for 25 minutes are not a failure; a terminal end is; a cancelled one counts as failed", "the panel's own update reloads the page at a known end, and not at its deadline", "a job running when the page opens is followed again: the panel, a part, a package job; the site update has nothing to resume", "Install security updates only when the server can install them and one security update exists, or while that job runs" |
| Hostile data on the pages is text; a refusal shows a catalog sentence, never the server's text or a code | `m5d-web-qa.test.ts`: "a block note on the Firewall page", "a package name, a version, a site and its owner on the Updates page", "a journal line in the one-panel viewer, and a service's state on Health", "a refusal is always a sentence of the catalog, never the server's text or a code", "the three senders show the catalog's sentence of a refusal, never its message" |
| R199 5: the two catalogs carry the same keys and placeholders | `m5d-web-qa.test.ts`: "the same keys and the same placeholders in both catalogs", "filled, no sentence keeps a brace, a key name or undefined", "the Italian text differs from the English one except for the words that are the same in both" (they are "Firewall" twice and "Container") |
| The customer's side did not change | `m5d-web-qa.test.ts`: "no Firewall or Updates link, no service restart and no host route on a customer page", "the customer's site-logs viewer renders as before: two panels, the customer texts, no journal sentence"; `apps/web/test/ui-copy.test.ts`: "customer surfaces avoid infrastructure jargon" (it reads the customer sections of both catalogs whole and the sources of `components/customer`, so it reads any customer key or source M5d changed; M5d added no customer key) |

### Test runs

This report's author ran each file alone with `timeout 300 corepack pnpm exec vitest run <file>`
from the repository root, one after another, on 2026-11-17, between 06:03 and 06:16 UTC (Node
26.13.1). The time is when the run began. The counts are what vitest printed. No total is given for
the whole suite. The files are those `git status` shows as new or changed in M5d under the test
folders of `packages/contracts`, `packages/database`, `packages/host-agent-contracts`,
`packages/executor-contracts`, `apps/host-agent`, `apps/docker-executor`, `apps/api`, `apps/web`
and `infra/`, plus `ui-copy.test.ts`, which is named above.

| File | Written by | Result |
|---|---|---|
| `packages/contracts/test/admin-firewall.test.ts` | engineers | 60 passed, 06:03:28 |
| `packages/contracts/test/admin-host.test.ts` | engineers | 6 passed, 06:03:28 |
| `packages/contracts/test/contracts.test.ts` | engineers | 50 passed, 06:03:29 |
| `packages/database/test/phase2-database.test.ts` | engineers | 16 passed, 06:03:29 |
| `packages/database/test/site-sftp-users-database.test.ts` | engineers | 6 passed, 06:03:32 |
| `packages/host-agent-contracts/test/host-agent-contracts.test.ts` | engineers | 10 passed, 06:03:35 |
| `packages/executor-contracts/test/executor-contracts.test.ts` | engineers | 13 passed, 06:03:36 |
| `apps/host-agent/test/host-agent.test.ts` | engineers | 21 passed, 06:03:36 (see the note below the table) |
| `apps/host-agent/test/host-job-units.test.ts` | engineers | 8 passed, 06:03:37 |
| `apps/host-agent/test/host-m5d.test.ts` | engineers | 107 passed, 06:03:37 |
| `apps/host-agent/test/host-simulator-m5d.test.ts` | engineers | 29 passed, 06:03:38 |
| `apps/docker-executor/test/panel-containers.test.ts` | engineers | 14 passed, 06:03:39 |
| `apps/docker-executor/test/panel-container-apply.test.ts` | engineers | 5 passed, 06:03:40 |
| `apps/docker-executor/test/panel-containers-qa.test.ts` | QA (executor, M5b; repaired by `qa-api`, R200) | 48 passed, 06:03:40 |
| `apps/api/test/firewall.unit.test.ts` | engineers | 13 passed (13), 06:04:09 |
| `apps/api/test/host-jobs.test.ts` | engineers | 16 passed (16), 06:04:11 |
| `apps/api/test/release-version.test.ts` | engineers | 11 passed (11), 06:04:18 |
| `apps/api/test/infra-layout.test.ts` | engineers | 31 passed (31), 06:04:18 |
| `apps/api/test/site-databases.unit.test.ts` | engineers | 20 passed (20), 06:04:19 |
| `apps/api/test/site-files.unit.test.ts` | engineers | 31 passed (31), 06:04:22 |
| `apps/api/test/site-sftp.unit.test.ts` | engineers | 15 passed (15), 06:04:25 |
| `apps/api/test/admin-firewall.integration.test.ts` | engineers | 1 failed, 10 passed (11), 06:04:26; see below |
| `apps/api/test/admin-host-services.integration.test.ts` | engineers | 10 passed (10), 06:04:44 |
| `apps/api/test/admin-updates.integration.test.ts` | engineers | 11 passed (11), 06:05:11 |
| `apps/api/test/admin-health.integration.test.ts` | engineers | 26 passed (26), 06:05:38 |
| `apps/api/test/admin-logs.integration.test.ts` | engineers | 10 passed (10), 06:06:22 |
| `apps/api/test/admin-route-guard.integration.test.ts` | engineers | 4 passed (4), 06:06:38 |
| `apps/api/test/site-databases.integration.test.ts` | engineers | 13 passed (13), 06:06:43 |
| `apps/web/test/admin-firewall.test.ts` | engineers | 28 passed (28), 06:06:52 |
| `apps/web/test/admin-updates.test.ts` | engineers | 18 passed (18), 06:06:53 |
| `apps/web/test/admin-health.test.ts` | engineers | 15 passed (15), 06:06:54 |
| `apps/web/test/admin-logs-audit.test.ts` | engineers | 25 passed (25), 06:06:55 |
| `apps/web/test/admin-restart.test.ts` | engineers | 25 passed (25), 06:06:56 |
| `apps/web/test/ui-copy.test.ts` | engineers (shipped) | 5 passed (5), 06:06:57 |
| `apps/web/test/m5b-web-qa.test.ts` | QA (web, M5b) | 36 passed (36), 06:06:57 |
| `apps/web/test/m5c-web-qa.test.ts` | QA (web, M5c) | 82 passed (82), 06:06:58 |
| `infra/linux/install.test.ts` | engineers | 39 passed (39), 06:06:59 |
| `infra/release/release-manifest.test.ts` | engineers | 12 passed (12), 06:07:01 |
| `apps/web/test/m5d-web-qa.test.ts` | QA (web, this report's author) | 5 failed, 91 passed (96), 06:08:07; the five fail on purpose for the defects below |
| `apps/host-agent/test/m5d-host-qa.test.ts` | QA (host), a colleague | 1 failed, 138 passed (139), 06:07:02; the one fails on purpose (`qa-host`'s defect: the slow `Inst` line pattern of `host-parsers.ts:114`, low) |
| `apps/api/test/m5d-api-qa.integration.test.ts` | QA (api), a colleague | 2 failed, 24 passed (26), 06:07:08; the two failing cases are named "defect probe" by their author: "P3 (defect probe): a restart reason holding NUL is refused with 400, never a 500" and "P5 (defect probe): a replayed panel-update key after site work began answers the first operation, not 409". Its author posted the same count (26, 2 failing on purpose) at 07:13 local |
| `apps/api/test/host-job-end-across-restart.integration.test.ts` | QA (api), a colleague | 1 failed, 5 passed (6), 06:15:50; the one fails on purpose: "(defect probe) the API closes promptly while it watches a host job, so a restart from the panel does not wait for the stop time-out" (`qa-api`'s defect, medium) |

The runs of the first 14 files printed no total in brackets: the line was cut by this author's
script, not by vitest. `m5d-web-qa.test.ts` was also run three times in a row before the table
(91 passed and the same five failed each time, 96 tests).

`admin-firewall.integration.test.ts`, "block and unblock: 201 then 200, every refusal with its
reason, 404 for an unknown or malformed id", is intermittent: it failed in the run above and in one
more run of the whole file, and of three runs of that case alone two passed and one failed. The
assertion that fails is that a refusal's body does not match `/flush|sneaky|198\.51\.100|bad/`;
vitest cuts the body it prints, so the matched text was not seen. The body holds a random request
id (`req_` and 32 hex digits, `apps/api/src/common/control-plane.error.ts`), which can contain
`bad`; that is a likely cause, but the number of failures seen is higher than its odds, so the cause
is not confirmed by this report's author. It was posted to the team channel. `qa-api` answered that the
case passed 4 of 4 runs alone for them, and that the same pattern is also run over block ids,
operation ids and audit rows, each 32 hex digits, which they put at about one run in ten; the
repair they propose is in the test (match only the planted words). Not a product defect.

**A note on `host-agent.test.ts`.** R199 point 2 says a worker leaves out its shipped case "invokes
nft with static argument arrays once SHA-256 verification succeeds and handles unprivileged verify
gracefully", because that case starts `nft -c -f` on the repository's ruleset file. This report's
author ran the whole file once (the row above) before stopping the batch, so that case ran once,
as an unprivileged user (a check that loads nothing). It was posted to the team channel at once.
No other file run here starts a program on this machine.

### Accept script on a real kernel (D28): reported by qa-host, not run by this report's author

`qa-host` wrote `infra/linux/accept-m5-firewall.mjs` (R198 2.6 moved it from the engineers to QA)
and reports that it ran twice in a row, 14 of 14 passed each time, with IPv6. Their last run, as
they report it:

```
PASS 01-ruleset-pin, 02-setup, 03-load-twice, 04-static-ports-v4, 05-static-ports-v6,
06-open-safe-port, 07-close-safe-port, 08-block-v4-address, 09-block-v4-network,
10-block-v6-address, 11-block-v6-network-keeps-nd-and-22, 12-unblock,
13-hostile-refused-before-nft, PASS nothing-left containers=0 networks=0 volumes=0,
RESULT 14/14 passed (prefix hp_swarmtest_m5f_ff8dd8c0, IPv6 run)
```

As the script's header says and its code shows, it loads the shipped
`infra/linux/nftables-dedicated.conf` with a real `nft` inside a throw-away container's own
network namespace (the local `alpine:3`, never pulled; the server container with `NET_ADMIN`
only, never privileged and never on the host's network), and drives the agent's own built code
(`buildFirewallSetsProgram`, `parseFirewallListing` and `validateFirewallSets` from
`apps/host-agent/dist`) against real connections from a second container. `qa-host` says the
`nft` there is Alpine's, not the 1.0.9 of Ubuntu noble. These results are theirs: this report's
author did not run the script and used no Docker. The script has no API and no database, so the
audit rows are proven by the API's tests above, not by it.

### Defects found by these runs, repaired by R201

| Defect | What the design says | What the code did | Where | Weight | Test |
|---|---|---|---|---|---|
| The Updates page says untrue sentences for most refusals | D25: every refusal says what to do next; R200 4: the routes as built | `updatesErrorText` gave its own sentence only for `RESOURCE_LOCKED` with `host_job_running`; everything else went to the shared catalog. A panel update refused with `site_work_running` and a container apply refused with `RESOURCE_LOCKED` said "This site is finishing another change" (no site is involved); a site update refused as `stopped` or `already_current` said "Check the highlighted fields" (there are none); `PANEL_CONTAINER_ABSENT`, `NOT_SUPPORTED` and `HOST_AGENT_UNAVAILABLE` said "contact support". On the Firewall page `HOST_AGENT_UNAVAILABLE` also said "contact support" | `apps/web/src/lib/admin-updates.ts:24`, `apps/web/src/lib/admin-firewall.ts` | medium | `m5d-web-qa.test.ts`: "the Updates page says a true sentence for each refusal its API gives (not a site's, not a field's, not 'contact support')": repaired by R201 1.6 (`updatesErrorText` picks a sentence of `admin.updates.errors` for each code and reason the Updates routes give: site work, busy, already current, stopped, absent, not supported, not found, agent out of reach, session ended, no answer, other; `firewallErrorText` maps `HOST_AGENT_UNAVAILABLE` to `admin.firewall.errors.agentDown`); passes |
| Six firewall refusals do not say what to do next | D25: every refusal says what to do next, in words an owner who never saw a server understands | `admin.firewall.refusals.invalid`, `too_wide`, `reserved`, `note_invalid` and `unknown_port` (and `own_address` in English) said only what is wrong; `reserved` said "unspecified, loopback, link-local or multicast" | `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/it.ts` (`admin.firewall.refusals`) | low to medium | `m5d-web-qa.test.ts`: "every refusal names what to do next": repaired by R201 1.7 (each of the six sentences now ends with the next step in both catalogs, and `reserved` says the address belongs to the server itself or to no single machine); passes |
| With no host row, the page asks to apply the base rules and offers no button | D25: every refusal says what to do next | The apply button is drawn only when `hostId` is set; the API answers `hostId: null` when no host row exists, while the sentence for absent or outdated base rules still asked to apply them | `apps/web/src/app/admin/firewall/page.tsx`; `apps/api/src/firewall/firewall.service.ts:180` | low | `m5d-web-qa.test.ts`: "base rules absent on a server without a host row: the sentence asks to apply them, so the page must offer a way": repaired by R201 1.8 (with base rules absent or outdated and no `hostId`, the page shows `admin.firewall.base.unregistered`, which says to run `sudo hp-accounts setup` over SSH, then reload the page); passes |
| Two buttons named "Check" on the Updates page | Every button's name says what it acts on | The panel's check and the package lists' check were both named "Check" ("Controlla"); a screen reader's list of buttons cannot tell them apart | `apps/web/src/app/admin/updates/page.tsx` | low | `m5d-web-qa.test.ts`: "every button on the Firewall and Updates pages has a name that says what it acts on: no two buttons share one": repaired by R201 1.9 (the buttons are now "Check for a new version" / "Cerca una nuova versione", "Refresh the package list" / "Aggiorna l'elenco dei pacchetti" and "Update the panel" / "Aggiorna il pannello"); passes |
| The BFF forwards a block id of the wrong shape | The closed form `fwb_` and 32 lowercase hex digits | Only the generic segment check ran: capitals or 33 digits reached the API, which answers `404` (R200 3: by design for the API) | `apps/web/src/app/api/admin/firewall/blocks/[blockId]/route.ts` | low | `m5d-web-qa.test.ts`: "%s: a parameter outside its closed form is 400 and nothing is forwarded", the row named "unblock": repaired by R201 1.10 (the route checks `FIREWALL_BLOCK_ID_PATTERN` first and answers `400 VALIDATION_ERROR` without calling the API); passes |
| A firewall case fails by chance | A test fails only when the code is wrong | "block and unblock" ran `/flush\|sneaky\|198\.51\.100\|bad/` over refusal bodies and audit rows that hold random ids of 32 hex digits (`req_…`, `fwb_…`, operation ids). `bad` is hexadecimal, so the case could fail with correct code; it failed in some runs above (see "Test runs") | `apps/api/test/admin-firewall.integration.test.ts:137-141,162` | low (a test, not the product) | `admin-firewall.integration.test.ts`: "block and unblock: 201 then 200, every refusal with its reason, 404 for an unknown or malformed id": repaired by R201 1.5 (the case looks only for the planted forms `flush`, `sneaky`, `198.51.100.` and `bad` followed within six characters by `note`, which no id or time stamp can make; it still checks that no refusal body and no audit row repeats the hostile input); passes 5 of 5 runs below, and 10 of 10 for `fix-api` |
| The API description does not parse (found by the lead, not by these runs) | `docs/api/openapi.yaml` is the API description as built | Two copies of the same 87 lines (the tail of the `Operation` schema, from its `required:` list to its timeline steps) sat inside the `pattern:` lines of `UpdatesDto` (`panel.installedVersion` and `panel.check.latestVersion`), and the closing `$'` of both patterns was missing: the mark of an edit made with a JavaScript replacement string that held `$'`, which means "the text after the match". A strict YAML load stops at the keys written twice | `docs/api/openapi.yaml` (`UpdatesDto`) | medium (no tool could read the file) | The lead's check, outside the repository (a strict YAML load that refuses a key written twice, checks every `$ref` and compares with the shipped description): repaired by R201 1.11 (both copies removed and both patterns closed again as `'^\d+\.\d+\.\d+$'`); ends `RESULT ok`. The repository's own tests still do not parse the file: `infra-layout.test.ts` reads it as text, and the repository has no YAML parser |

The first six were posted to the team channel; the seventh is in R201. The first five are repaired
by `fix-web`, the sixth by `fix-api` and the seventh by `fix-docs`.

Colleagues posted these defects from their own files (not found by this report's tests). All four
are repaired by R201 (`fix-api`):

| Defect | What the design says | What the code did | Where | Weight | Test |
|---|---|---|---|---|---|
| The API does not close while it watches a host job (`qa-api`) | R201 1.1: a stop of the API is prompt | `stop()` waited for the host lane, which followed a running host job for up to two hours, so `hp-api` waited for systemd's stop time-out when the panel restarted it | `apps/api/src/runtime/outbox-worker.service.ts:256-281`, `apps/api/src/host/host-jobs.ts:197-242` | medium | `host-job-end-across-restart.integration.test.ts`: "(defect probe) the API closes promptly while it watches a host job, so a restart from the panel does not wait for the stop time-out": repaired by R201 1.1 (`stop()` raises a signal that `executeHostJob` receives: both its waits end at once and the follow returns without writing; the job goes on and the recovery pass after the next start records its end, ADR 0028 limit 24); passes. `host-jobs.test.ts` has four cases named "R201 1.1: …"; they pass |
| A replayed key after site work began answers `409` (`qa-api`) | R201 1.2: a replayed key answers its first operation | The check for running site work ran for every request, a replayed one too, so the replay of a key accepted before a backup started was refused with `409` | `apps/api/src/host/host-jobs.ts:76-124` | low to medium | `m5d-api-qa.integration.test.ts`: "P5 (defect probe): a replayed panel-update key after site work began answers the first operation, not 409": repaired by R201 1.2 (the check runs only when the enqueue made a new operation, in the same transaction, so a refused new request leaves no operation and no audit row); passes. `host-jobs.test.ts`: "R201 1.2: once site work runs, a replayed key answers its operation; a new key is refused and leaves no row"; passes |
| A restart reason holding NUL answers `500` (`qa-api`) | R201 1.3: a bad body is a `400` | `RestartInputSchema` accepted U+0000 (`trim()` keeps it) and PostgreSQL refused the audit row | `packages/contracts/src/admin-health.ts:32-34` | low | `m5d-api-qa.integration.test.ts`: "P3 (defect probe): a restart reason holding NUL is refused with 400, never a 500": repaired by R201 1.3 (`RestartInputSchema` refuses a reason holding U+0000, so the three restart routes answer `400 VALIDATION_ERROR`); passes. `fix-api` narrowed the case to the status and the code, because a contract refusal carries its Zod issue code as its reason. `contracts.test.ts`: "refuses a reason holding U+0000 anywhere; a line break stays accepted"; passes |
| The slow `Inst` line pattern (`qa-host`) | R201 1.4: the package parser reads a line in linear time | The origins group `.+` before ` [` backtracked quadratically on a long line of brackets | `apps/host-agent/src/host-parsers.ts:115` | low | `m5d-host-qa.test.ts`: "apt-get -s upgrade with a 96,000-char bracket line is refused within 250 ms": repaired by R201 1.4 (the origins group takes no bracket, `[^[\]]+`); passes. The real-line fixtures of `host-m5d.test.ts` still pass |

### Runs after R201

This report's author ran each file alone with `timeout` and `corepack pnpm exec vitest run <file>`
from the repository root, one after another, on 2026-11-17, between 06:34 and 06:48 UTC (Node
26.13.1), after `fix-web` and `fix-api` posted their repairs. The time is when the run began. The
counts are what vitest printed.

| File | Result |
|---|---|
| `apps/web/test/m5d-web-qa.test.ts` | 96 passed (96), 06:34:22 |
| `apps/web/test/admin-firewall.test.ts` | 28 passed (28), 06:34:24 |
| `apps/web/test/admin-updates.test.ts` | 18 passed (18), 06:34:25 |
| `apps/api/test/host-job-end-across-restart.integration.test.ts` | 6 passed (6), 06:42:50 |
| `apps/api/test/admin-firewall.integration.test.ts` | 11 passed (11), 06:43:01; again 11 passed (11) at 06:46:35, 06:46:53, 06:47:10 and 06:47:28 |
| `apps/api/test/m5d-api-qa.integration.test.ts` | 26 passed (26), 06:43:23 |
| `apps/host-agent/test/m5d-host-qa.test.ts` | 139 passed (139), 06:44:22 |
| `packages/contracts/test/contracts.test.ts` | 51 passed (51), 06:44:26 |
| `apps/host-agent/test/host-m5d.test.ts` | 107 passed (107), 06:44:32 |
| `apps/api/test/host-jobs.test.ts` | 21 passed (21), 06:44:44 |

### Defects found by the review, repaired by R202

| Defect | What the design says | What the code did | Where | Weight | Test |
|---|---|---|---|---|---|
| On a server installed with `--skip-firewall` the panel could load its base rules and close SSH on another port | R202 1.1: the panel changes the firewall only where `/etc/nftables.d/hosting-panel.nft` exists; `install.sh` writes it only without `--skip-firewall`, after checking SSH listens on 22 | `readFirewall` answered `absent` when the table did not exist, and the apply ran `nft -f` on the ruleset, which drops every incoming connection except tcp 22, 80 and 443; the page offered the button for `absent` or `outdated` with a host row, and the Server page of step 2 (`host-detail-actions.tsx`) posts to the same route | `apps/host-agent/src/linux-adapter.ts` (`firewallInstalled`, `readFirewall`, `executeSecurityPolicy`, `replaceFirewallSets`); `apps/api/src/firewall/firewall.service.ts`; `packages/contracts/src/ipc-schemas.ts`; `apps/web/src/app/admin/firewall/page.tsx` | high | `apps/host-agent/test/host-m5d.test.ts`: "reads unmanaged and starts no program", "counts a path that is not a file as no copy", "ends %s failed with a fixed reason before any nft call", "refuses a change with RESOURCE_LOCKED and starts no program", "with the copy back, applies the ruleset as before", "carries unmanaged across the wire: the server answers it, the client parses it, a change is 409 (R202 1.3)"; `packages/contracts/test/contracts.test.ts`: "carries the four base rule states the agent reads, unmanaged among them (R202 1.3)"; `apps/api/test/firewall.unit.test.ts`: "unmanaged (R202 1.3): start pass loads nothing, changes answer as for absent, the view says unmanaged"; `apps/web/test/admin-firewall.test.ts`: "%s: unmanaged shows its sentence, no apply and no enabled change control"; `apps/web/test/m5d-web-qa.test.ts`: "R202: the base rules' sentences name 22, 80 and 443 and warn about SSH on another port; unmanaged says how to hand over": all pass. Repaired: without the file (or if it is not a file) the agent starts no `nft`, reads `unmanaged`, ends the base-rules apply and its verify `failed` with "panel firewall not installed on this server" and refuses the lists with `RESOURCE_LOCKED`; the API answers a change `409 FIREWALL_BASE_RULES_NOT_CURRENT` and its start pass loads nothing; the page says the panel does not manage this server's firewall and how to hand it over, and offers no apply and no change |
| A host job whose agent cannot answer never ended and held `host:job` for good | R202 2.1: a job that cannot start ends `not_started` | `executeHostJob` treated every error of the request except two as "may have started", and `endOf` and `recoverHostJob` read a failed read as pending for ever | `apps/api/src/host/host-jobs.ts` | medium | `apps/api/test/host-jobs.test.ts`: "R202 2.1: a request refused with NOT_SUPPORTED ends not_started with that code and reads nothing", "R202 2.1: a NOT_SUPPORTED read keeps polling inside the start deadline and ends not_started past it", "R202 2.1: an agent out of reach past the start deadline is still not an end", "R202 2.1: recovery settles a NOT_SUPPORTED read only past the start deadline, never an agent out of reach": all pass. Repaired: a request refused with `NOT_SUPPORTED` settles `not_started` at once with that code; a `NOT_SUPPORTED` read settles it only past the 120 s start deadline; an agent out of reach stays pending; recovery follows the same rule |
| A site image update could leave a deploy with no audit row | R202 2.2: the row and the operation are written together | The `admin.update.site_image` row was written after `changeRuntime` committed, in a statement of its own, and a replay of the key hid a missing row | `apps/api/src/updates/updates.service.ts`; `apps/api/src/sites/managed-sites.service.ts` (`changeRuntime`) | medium | `apps/api/test/admin-updates.integration.test.ts`: "R202 2.2: an image update whose audit row cannot be written leaves no operation and answers an error"; `apps/api/test/m5d-api-qa.integration.test.ts`: "P12 (R202 2.2): when the site_image row cannot be written no deploy is left; a retry with the same key deploys once with one row": both pass. Repaired: `changeRuntime` writes the row through a callback in the transaction that creates the operation, only when the operation is new |
| A key used for one site, sent for another, answered the first site's operation | R202 3: a replay answers only its own request | The replay check matched only the organisation and the key | `apps/api/src/updates/updates.service.ts` | low | `apps/api/test/admin-updates.integration.test.ts`: "R202 3: a key used for site A, sent for site B, never answers site A's operation": passes. Repaired: the replay matches kind `service.deploy` and lock `site:<id>` |
| Apply of the shared database ran during site work | R202 3: it restarts the database every site uses | The container apply never looked at site work | `apps/api/src/updates/updates.service.ts` | low | `apps/api/test/admin-updates.integration.test.ts`: "R202 3: shared_database apply waits for site work; other containers do not; a replay answers its operation": passes. Repaired: a new request for `shared_database` calls `assertNoSiteWork` in the enqueue transaction (`409`, `site_work_running`); a replay answers its operation |
| A package list file removed during a refresh failed the read | R202 3 | `newestAptListTime` failed on any stat error | `apps/host-agent/src/linux-adapter.ts` | low | `apps/host-agent/test/host-m5d.test.ts`: "skips a file gone between the listing and its stat; any other stat failure still fails the read": passes. Repaired as the name says |
| `::1.2.3.4` and `::/96` were accepted | IPv4 inside IPv6 is refused | `RESERVED` lacked `::/96` | `packages/contracts/src/admin-firewall.ts` | low | `packages/contracts/test/admin-firewall.test.ts`: "refuses $input as $reason and never echoes it" with `::/96`, `::102:300/120` and `::1.2.3.4` as `reserved`: passes |
| The page's sentences on the base rules, port 3000, the not-in-force banner and the update rollback were untrue or incomplete | R202 3: every sentence true of the ruleset and the code | `base.absent`, `applyTitle` and `applyBody` did not name the ports left open; `static.panel` did not say the console is reached through the web ports; the banner did not say to unblock first; `updateFacts` did not say a rollback restarts the database and the proxy once more | `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/it.ts` | low | `apps/web/test/m5d-web-qa.test.ts`: "R202: the base rules' sentences name 22, 80 and 443 and warn about SSH on another port; unmanaged says how to hand over": passes |
| Command sentences did not say where to type them | R202 3 | Sentences named a command without saying it is typed on the server, over SSH | `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/it.ts` | low | `apps/web/test/m5d-web-qa.test.ts`: "R202: a sentence of Firewall or Updates that names a command says it is typed on the server, over SSH": passes |
| A follow kept polling after a 401 | R202 3 | `followRestart` went on after a 401 | `apps/web/src/lib/admin-restart.ts` | low | `apps/web/test/m5d-web-qa.test.ts`: "a follow that gets 401 stops at the first one and ends signed out": passes. Repaired: it returns `signedOut` at the first 401 |
| The firewall BFF gave up before the API's worst case | R202 3 | The four firewall BFF routes and the page's own read did not wait as long as the API's worst case | `apps/web/src/app/api/admin/firewall/`, `apps/web/src/app/admin/firewall/page.tsx` | low | `apps/web/test/admin-firewall.test.ts`: "%s hands on a time-out above the API's worst case", "the page's own read waits as long", "%s: the apply button's answers: a host row gone, no answer, a lost connection": all pass. Repaired: `FIREWALL_BFF_TIMEOUT_MS` is 65000 |
| A path parameter holding `%00` answered `404` with no denied row | R202 5: every denial leaves its row | U+0000 reached the denied row's `targetId`, which PostgreSQL refuses, so the request ended without its denied row | `apps/api/src/auth/authz-context.service.ts` (`recordDeniedAudit`) | low | `apps/api/test/admin-route-guard.integration.test.ts`: "R202 5: a path parameter holding %00 still answers a customer 403 with one denied row": passes. Repaired: U+0000 in `targetId` is written as U+FFFD |
| Documents untrue after R201 | R202 3 | README named the Updates buttons "Controlla", "Aggiorna" and "Aggiorna l'elenco"; this report said the page without a host row offered an apply; OpenAPI lacked `unmanaged` | `README.md`, this report, `docs/api/openapi.yaml` | low | No test reads them. Repaired against the code and the i18n catalogs; the OpenAPI check script ends `RESULT ok` (refs 156, without a target 0) |

Accepted by R202 point 4, not repaired, each written as a limit in ADR 0028: host jobs and "Apply"
share one lane, so an Apply older than 60 s when its turn comes ends `OPERATION_INTERRUPTED` and a
host job past 120 s ends `not_started` (limit 16); site work does not wait for a host job (limit
26); a repeated mail-relay Apply writes a second audit row (limit 15); "current" only means the
three sets exist (limit 27).

### Runs after R202

This report's author ran each file alone with `timeout` and `corepack pnpm exec vitest run <file>`
from the repository root, one after another, on 2026-11-17, between 07:47 and 07:59 UTC (Node
26.13.1), after `r1-web` and `r1-core` posted their repairs. The time is when the run began. The
counts are what vitest printed.

| File | Result |
|---|---|
| `apps/web/test/m5d-web-qa.test.ts` | 98 passed (98), 07:47:58 |
| `apps/web/test/admin-firewall.test.ts` | 37 passed (37), 07:48:00 |
| `apps/web/test/admin-updates.test.ts` | 18 passed (18), 07:48:01 |
| `apps/web/test/admin-restart.test.ts` | 25 passed (25), 07:48:02 |
| `apps/host-agent/test/host-m5d.test.ts` | 115 passed (115), 07:57:20 |
| `packages/contracts/test/admin-firewall.test.ts` | 63 passed (63), 07:57:21 |
| `packages/contracts/test/contracts.test.ts` | 52 passed (52), 07:57:22 |
| `apps/api/test/host-jobs.test.ts` | 25 passed (25), 07:57:22 |
| `apps/api/test/firewall.unit.test.ts` | 14 passed (14), 07:57:35 |
| `apps/api/test/admin-updates.integration.test.ts` | 14 passed (14), 07:57:42 |
| `apps/api/test/m5d-api-qa.integration.test.ts` | 26 passed (26), 07:58:14 |
| `apps/api/test/admin-route-guard.integration.test.ts` | 5 passed (5), 07:59:12 |

### Defects found by the second review, repaired by R203

| Defect | What the design says | What the code did | Where | Weight | Test |
|---|---|---|---|---|---|
| A host job that did start could be recorded as "did not start" | R203 1.1: after the trigger file is written the request starts no program; 1.2: on the two job calls `NOT_SUPPORTED` means only missing units | `requestHostJob` ended with a second `systemctl show` after the job was handed to root, and every failed `systemctl` (exit, time limit, an answer it could not read) was `NOT_SUPPORTED`, which the API settles as not started past 120 s, freeing `host:job` while root's unit ran | `apps/host-agent/src/linux-adapter.ts` (`jobRead`, `requestHostJob`, `readHostJob`); the comment at `endOf` in `apps/api/src/host/host-jobs.ts` | medium | `apps/host-agent/test/host-m5d.test.ts`: "R203 1.1: a request whose trigger was written answers running and starts systemctl once", "R203 1.2: a first read that fails refuses the request with HOST_AGENT_UNAVAILABLE and writes no trigger", "R203 1.2: a read with a failing runner or an unreadable answer is HOST_AGENT_UNAVAILABLE with the fixed sentence", "R203 1.2: units that are not loaded stay NOT_SUPPORTED with the units sentence", "writes exactly the fixed empty file of the job and answers running without a second read (R203 1.1)"; `apps/api/test/host-jobs.test.ts`, unchanged: "R202 2.1: an agent out of reach past the start deadline is still not an end": all pass. Repaired: after the write the request answers running from the blocks read before it; on the two job calls only `HOST_JOB_UNITS_MISSING` is `NOT_SUPPORTED`, any other `systemctl` failure is `HOST_AGENT_UNAVAILABLE` (503) with the fixed sentence; a write that fails with anything but `EEXIST` stays `NOT_SUPPORTED`. The API's rule did not change |
| Handing the firewall to the panel as the README said could put an older panel back | R203 2.1: the installer refuses an older version than the installed one; 2.2: its test root is temporary; 2.3: the hand-over keeps the installed version | `install.sh` swapped `current` to the version given with no comparison, and the README and `base.unmanaged` said to rerun the installation command, which names the archive of the first version | `infra/linux/install.sh`; `README.md`; `apps/web/src/i18n/en.ts`, `it.ts` (`base.unmanaged`) | medium | `infra/linux/install.test.ts`: "refuses --version 0.3.0 over an installed 0.3.1 with exit 2, naming both, and changes nothing", "refuses an older --archive over an installed release", "goes on with the same version, a newer one, or no installed release", "without --version or --archive the dry run says the check waits for the lookup", "refuses HP_INSTALL_ROOT outside a dry run"; `apps/web/test/m5d-web-qa.test.ts`: "R202: the base rules' sentences name 22, 80 and 443 and warn about SSH on another port; unmanaged says how to hand over": all pass. Repaired: after the `latest` lookup and before the archive is verified, an installed version newer than the one given ends the installer with exit 2, a sentence naming both versions and the two ways on (`--version` with the installed one, or `hp-update --allow-downgrade`); a dry run on `latest` says in one line of its plan that the check waits for the lookup; `HP_INSTALL_ROOT` moves the root for tests and is refused outside a dry run; every test run gets a temporary root. The sentences say: the installer again, over SSH, with `--version` and the installed version the Updates page shows, without `--skip-firewall`; the panel restarts and is away for about a minute |
| On `unmanaged` a change was refused with "Apply them first", an apply that always fails | R203 3.1 | `#change` gave the same message in every state; `errors.notCurrent` ended "Apply the base rules and try again" | `apps/api/src/firewall/firewall.service.ts`; `apps/web/src/i18n/en.ts`, `it.ts` | low | `apps/api/test/firewall.unit.test.ts`: "unmanaged (R202 1.3): start pass loads nothing, changes answer as for absent, the view says unmanaged"; `apps/web/test/m5d-web-qa.test.ts`: "R202: the base rules' sentences name 22, 80 and 443 and warn about SSH on another port; unmanaged says how to hand over": both pass. Repaired: on `unmanaged` the same code with "The panel firewall is not installed on this server."; `errors.notCurrent` ends "Reload the page, which says what to do." |
| The simulator applied the base rules on `unmanaged` | R203 3.2: as the real agent | `executeSecurityPolicy` of the simulator never looked at `unmanaged` | `apps/host-agent/src/simulator-adapter.ts` | low | `apps/host-agent/test/host-simulator-m5d.test.ts`: "R203 3.2: refuses the apply on unmanaged, as the real agent, and changes no state": passes. Repaired: the apply ends `failed` with "panel firewall not installed on this server" and changes no state |
| This report named a test that no longer exists | R203 3.3 | The R198 table quoted the follow test by its name before R202 | this report | low | `apps/web/test/m5d-web-qa.test.ts`: "a follow that gets 401 stops at the first one and ends signed out": passes; the name is quoted as it is |
| "Everything else incoming is closed" was untrue for site SFTP on 2222 | R203 3.4 | The base rules filter the `input` chain only; 2222 is forwarded to a container and never passes it | `apps/web/src/i18n/en.ts`, `it.ts` (`base.absent`, `base.applyBody`); `README.md` | low | `apps/web/test/m5d-web-qa.test.ts`: "R202: the base rules' sentences name 22, 80 and 443 and warn about SSH on another port; unmanaged says how to hand over" (its `applyBody` pattern now matches the clause that closes everything else, except site SFTP on port 2222, R203 3.6): passes |
| No test checked that the apply shows the base rules' error sentences | R203 3.5 | The page's `errors="firewall-base"` was read by no test | `apps/web/test/admin-firewall.test.ts` | low | `apps/web/test/admin-firewall.test.ts`: "%s: the warning, Apply base rules with a hostId, every change control disabled": passes. It records the props of every `ConfirmAction` and checks the apply gets `errors: "firewall-base"`; changed to expect "firewall", it failed with "firewall-base" received |
| The Health case ran out of the 5 s of a test in the whole suite | R203 4: not a defect of the product | The start of the application took most of the 5 s | `apps/api/test/admin-health.integration.test.ts` | low | "an agent that never answers still gives Health within the 3 s bound, with hostServices null": passes, with its own limit of 15 s; its assertion that the read takes less than 5 s stays |

Two shipped assertions changed with R203 1.1, because they counted the second `systemctl show` it
removes: in `apps/host-agent/test/host-m5d.test.ts` the case once called "writes exactly the fixed
empty file of the job and answers a fresh read" now expects one `systemctl` call and is called
"writes exactly the fixed empty file of the job and answers running without a second read (R203
1.1)"; in `apps/host-agent/test/m5d-host-qa.test.ts` "%s writes one empty 0600 file with its fixed
name and nothing else" expects one call instead of two.

Recorded by R203 point 5, not repaired: the start pass on an `unmanaged` server sends one refused
`replaceFirewallSets` and logs one line; Traefik's read time limit (60 s by default) may end the
firewall request before the page's 65 s (M6); a later installer run with `--skip-firewall` leaves the
sign file, and a sign file deleted by hand shows `unmanaged` too (both in ADR 0028 limit 25); a
newer version given to the installer is an update without `hp-update`'s health check and way back
(ADR 0028 limit 28, a guard is M6); the step-2 Hosts page's Verify ends failed on a `--skip-firewall`
server; `restart_hp_host_agent` answers right after the write, so systemd stopping the agent first
gives `OPERATION_AMBIGUOUS` and the API polls; the `phpVersion` assertion that cannot fail stays.

### Runs after R203

The engineer of R203 (`r2-fix`) ran each file alone with `timeout 300 corepack pnpm exec vitest run
<file>` from the repository root, one after another, on 2026-11-17 between 08:45 and 08:47 UTC (Node
26.13.1), after every repair. The time is when the run began. The counts are what vitest printed.
`bash -n infra/linux/install.sh`, eslint on every changed code file and the `typecheck` scripts of
the host agent, the API and the web app ended without error.

| File | Result |
|---|---|
| `apps/host-agent/test/host-m5d.test.ts` | 119 passed (119), 08:45:16 |
| `apps/host-agent/test/m5d-host-qa.test.ts` | 139 passed (139), 08:45:16 |
| `apps/host-agent/test/host-simulator-m5d.test.ts` | 30 passed (30), 08:45:21 |
| `apps/api/test/host-jobs.test.ts` | 25 passed (25), 08:45:21 |
| `apps/api/test/firewall.unit.test.ts` | 14 passed (14), 08:45:34 |
| `apps/api/test/admin-firewall.integration.test.ts` | 11 passed (11), 08:45:37 |
| `apps/api/test/admin-health.integration.test.ts` | 26 passed (26), 08:45:54 |
| `infra/linux/install.test.ts` | 44 passed (44), 08:46:37 |
| `apps/web/test/admin-firewall.test.ts` | 37 passed (37), 08:46:40 |
| `apps/web/test/m5d-web-qa.test.ts` | 98 passed (98), 08:46:41 |
| `apps/api/test/infra-layout.test.ts` | 31 passed (31), 08:46:43 |

### The lead's runs of cycle 13

All on 2026-11-17, Node 26.13.1. "Tree" is the id of a snapshot of the uncommitted working tree,
the run folder `.herdr-swarm` left out. This report's author did not run them.

The whole checks (`corepack pnpm run build`, `lint`, `typecheck`, `test`):
- run `c13-qa`, on the tree the test phase left: build, lint and typecheck exit 0; `test` exit 1
  with 201 test files, 9 tests failed, 3806 passed, 43 skipped. The nine failures are exactly the
  nine cases the test phase left failing on purpose, each for a defect R201 then repaired (five in
  the web app, three in the API, one in the host agent).
- run `c13-fixqa`, on the tree after the repair of R201 (`18deb98`), the one the four reviewers of
  round 1 read: all four exit 0; 201 test files, 3821 passed, 43 skipped, none failed.
- run `c13-r1`, on the tree after the repair of round 1 (`fbfa36e`), the one the two reviewers of
  round 2 read: build, lint and typecheck exit 0; `test` exit 1 with 201 test files, 3852 passed, 43
  skipped, 1 failed: "an agent that never answers still gives Health within the 3 s bound, with
  hostServices null" in `apps/api/test/admin-health.integration.test.ts` ran out of the 5 s a test
  gets, under the load of the whole suite (run alone it passed, in about 4.4 s). R203 point 4 gave the
  case 15 s.
- run `c13-r2`, on the tree after the repair of round 2 (`9e63275`): all four exit 0; 201 test
  files, 3863 passed, 43 skipped, none failed.

The eleven real-Docker scripts of that time (`accept-m1-files`, `accept-m1-sftp`, `accept-m2-databases`,
`accept-m2-phpmyadmin`, `accept-m3-backups`, `accept-m3-panel`, `accept-m4-wordpress`,
`accept-m4-import`, `accept-m5-health`, `accept-m5-terminal`, `accept-m5-firewall`; the twelfth,
`accept-m6-site-type`, came later, see M6b), on throw-away containers only, with what was left behind counted afterwards:
- run `c13`, on the tree after the repair of R201 (`18deb98`): all eleven passed (17/17, 19/19,
  17/17, 24/24, 28/28, 13/13, 12/12, 13/13, 6/6, 11/11, and the firewall script 14/14 with its
  IPv6 steps); containers, volumes, networks and shared-memory files left behind: 0, 0, 0, 0.
- run `c13b`, on the tree after the repair of round 1 (`fbfa36e`): all eleven passed with the same
  counts; left behind: 0, 0, 0, 0.
- run `c13c`, on the tree after the repair of round 2 (`9e63275`): the summary
  `.herdr-swarm/swarm-1114-132739/scratch/c13c-accept-summary.log` reads, word for word:

```
v26.13.1
m1-files exit=0 fail=0 | accept-m1-files: 17/17 passed in 12.8s
m1-sftp exit=0 fail=0 | accept-m1-sftp: 19/19 passed in 35.5s
m2-databases exit=0 fail=0 | accept-m2-databases: 17/17 passed in 18.5s
m2-phpmyadmin exit=0 fail=0 | accept-m2-phpmyadmin: 24/24 passed in 56.7s
m3-backups exit=0 fail=0 | accept-m3-backups: 28/28 passed in 226.1s
m3-panel exit=0 fail=0 | RESULT 13/13 passed in 79s
m4-wordpress exit=0 fail=0 | 12/12 passed in 169.3 s
m4-import exit=0 fail=0 | 13/13 passed in 127.6 s
m5-health exit=0 fail=0 | RESULT 6/6 passed
m5-terminal exit=0 fail=0 | RESULT 11/11 passed
m5-firewall exit=0 fail=0 | RESULT 14/14 passed (prefix hp_swarmtest_m5f_4ea22560, IPv6 run)
left-containers=0
left-volumes=0
left-networks=0
left-shm=0
end-accept
```

The reviews. Round 1: four reviewers read the tree `18deb98` and found one high, two medium and
thirteen low defects; R202 decided them (table above). Round 2: two reviewers read the tree
`fbfa36e`, the repair of round 1, and found two medium and six low defects, both medium ones opened
by that repair; R203 decided them (table above). **The repair of R203 (tree `9e63275`) was read by
no reviewer:** the cycle's thirty agents ended with its engineer. The lead read its whole patch
against the tree `fbfa36e` and against R203, checked that every test name this report quotes for it
exists in its file, and ran the two runs `c13-r2` and `c13c` above on it.

### Not proven

- R198 point 5, one item at a time (there is no root and no published release here):
  - the root units started by a trigger file under a real systemd as installed;
  - `hp-update` run by its unit;
  - `apt-get update` and `unattended-upgrade` run by their units;
  - the agent's sandbox with the journal group;
  - the bus for `systemctl show` and `apt-get -s`;
  - `nft` 1.0.9 of Ubuntu noble (the architects ran 1.1.6, `qa-host`'s script ran Alpine's);
  - the proxy's `X-Real-Ip` as the web app receives it (the BFF's use of it is proven on headers
    written by the tests);
  - the session across a panel update (the page's reload is proven with a stand-in `window`);
  - a block against a port a container publishes (the DNAT case) outside a container's own
    namespace.
- Risks the architects named and accepted that no test closes:
  - R198 2.2: once an address is blocked, the server and the sites no longer get answers from it.
    Only the sentence that says so in the block dialog is tested.
  - R198 2.9: during "Apply again" there is an instant when opened ports are closed and blocks are
    lifted. No test measures it.
  - R198 3.1 (D19): what `unattended-upgrades`, installed by `install.sh`, does by its own defaults
    on a server.
  - R198 3.2: port 3000 stays reachable from every non-internal bridge, so the own-address check is
    advice, not a boundary.
  - ADR 0028 limit 22 (a firewall change goes ahead when the kernel read fails) is tested as built
    (`firewall.unit.test.ts`: "an unreadable agent: the change is stored, baseRules unreadable,
    inForce null"); `docs` asked the reviewer whether the design meant it.
- What the engineers' and colleagues' reports say they could not test:
  - the real sandbox, the JSON listing and error text of `nft` 1.0.9, and the real output of
    `systemctl`, `journalctl` and `apt-get`: every fixture is invented (`eng-agent`, `qa-host`);
  - the live bootstrap, and path units triggering under a real systemd (`eng-units`);
  - a real request to GitHub, an image pull on a real Docker Engine, the mail relay apply reaching
    the executor, and a site update refused because the site is busy (`ops-2`);
  - the end of a job recorded once across a restart of the real `hp-api` service (`ops-1`); `qa-api`'s
    file above stops one app and starts a second over the same database, in one test process;
  - the verify path without `CAP_NET_ADMIN` on a real kernel (`qa-host`);
  - the dialogs opening, the click handlers and the follow to the end in a browser (`web-fw`,
    `web-ops`). This report's tests call the handlers through a stand-in for React's hooks, with no
    DOM; they depend on the order of each component's state and ref calls and can break on a React
    upgrade while the page still works.
- R202 point 5, named by the review and closed by no test:
  - the 30 s lease against a slow first follow step;
  - the package list, bounded only by the 1 MiB of the read;
  - DHCP and path-MTU answers under a block;
  - whether `nft` 1.0.9 merges adjacent networks;
  - a package upgrade of `nftables` that flushes the ruleset;
  - the 30 minutes `hp-panel-update.service` allows;
  - two requests for one job at the same instant.
- R202 1.5 (ADR 0028 limit 25): the SSH port is checked once, by the installer. An administrator who
  later moves SSH off 22 on a server that has `/etc/nftables.d/hosting-panel.nft` is told the ports by
  the apply dialog, not stopped; the agent cannot learn the SSH port. The Server page of step 2
  (`host-detail-actions.tsx`) shows a refused apply as a failed operation, without the reason
  sentence.
- The repair of R203 was read by no reviewer: the cycle's thirty agents ended with it. The lead read
  its patch against tree `fbfa36e` and ran the checks ("The lead's runs of cycle 13"). The runs in
  "Runs after R203" are its engineer's.
- R203 point 5, recorded and closed by no test: `restart_hp_host_agent` stopped by systemd before
  its answer leaves (read in the code by the reviewer, run by nobody); Traefik's 60 s read time limit
  against the page's 65 s; the installer's refusal of an older version on a real installed root (the
  tests use a temporary root in dry runs).
- Nobody opened the Firewall, Updates, Health or Logs pages in a browser, and no screen reader was
  used. Accessibility is proven only as roles, labels and names in the markup.
- No test of this report ran a real `systemctl`, `journalctl`, `apt-get`, `unattended-upgrade` or
  Docker. The one `nft` run is named in "Test runs".

## M6b: the audit and its repairs

The audit of the whole tree, its findings and what became of each are in
`docs/security/audit-report.md`. This part holds the runs of the lead on the tree after the last
read of the cycle: 2026-11-17, Node 26.13.1, one run after another on one machine.

### The four sensors

Build, lint, typecheck and test each at exit 0: 229 test files, 4140 tests passed, 43 skipped,
0 failed. The run before the last repairs (`c15-fix`, R207 addendum 4) had 7 failed tests in 3
files; no test fails now.

### The release build and its smoke

`corepack pnpm run release:build` and `corepack pnpm run release:smoke` each at exit 0. The
archive is `hosting-panel-0.5.0-linux-x64.tar.gz` (116.8 MiB); the smoke ends with `smoke: PASS`.

### The twelve real-Docker scripts

Each script ran alone, with throw-away containers, volumes and networks of its own. After the
last one, none of them was left.

| Script | Result |
|---|---|
| `infra/linux/accept-m1-files.mjs` | 17 of 17 passed |
| `infra/linux/accept-m1-sftp.mjs` | 19 of 19 passed |
| `infra/linux/accept-m2-databases.mjs` | 19 of 19 passed |
| `infra/linux/accept-m2-phpmyadmin.mjs` | 24 of 24 passed |
| `infra/linux/accept-m3-backups.mjs` | 29 of 29 passed |
| `infra/linux/accept-m3-panel.mjs` | 13 of 13 passed |
| `infra/linux/accept-m4-wordpress.mjs` | 12 of 12 passed |
| `infra/linux/accept-m4-import.mjs` | 13 of 13 passed |
| `infra/linux/accept-m5-health.mjs` | 6 of 6 passed |
| `infra/linux/accept-m5-terminal.mjs` | 11 of 11 passed |
| `infra/linux/accept-m5-firewall.mjs` | 19 of 19 passed (the IPv6 checks ran) |
| `infra/linux/accept-m6-site-type.mjs` | 15 passed, 0 failed, 1 skipped |

The real-Docker proofs that R207 asked for are among them:

- `data.1`, the new database password of a moved site: check `owner-change-new-password` of
  `accept-m2-databases.mjs`.
- `data.2`, the upgrade of the database accounts that exist: check `upgrade-old-accounts` of the
  same script.
- `restore.1`, no restore container with the site volume and the staging volume together: checks
  `restore-mounts-as-ruled` and `restore-planted-link-never-replayed` of `accept-m3-backups.mjs`.
- `host.1`, the forward chain: checks `14-forward-chain-listed`, `15-press-on-a-0.5.0-table`,
  `16-bridge-to-metadata-dropped-dns-passes`, `17-udp-dns-passes` and
  `18-bridge-to-metadata6-dropped` of `accept-m5-firewall.mjs`, inside a throw-away container.

The tree of these runs holds everything built after `c15-fix`, each with its tests (listed in the
audit report): R207 addendum 4 A to D (`a.1`, `a.2`, `d.1` and the E7 test) and the repairs that
the two reviews of the repairs asked for (`a.3` to `a.8`, `d.2`, `d.3`).

### Not proven

- The skipped check of `accept-m6-site-type.mjs` is `sftp-real-login`: the SFTP server refused the
  login of a site whose files belong to group 1000, because its group line is fixed at 33. This is
  limit 5 of ADR 0029. The SFTP login of a WordPress site is proven by `accept-m1-sftp.mjs`.
- No run above tries the open medium finding of the last read (LR-M1 in the audit report).
- These lines were written after the runs. Between the tree of the runs and the tree with these
  lines, only this report, the audit report and one sentence of `.agents/brain/state.md` differ.

Only the owner can check the base rules on a real kernel next to Docker's chains, and Ubuntu's
`nft` reading the rules file: see "What only the owner can check" in the audit report.
