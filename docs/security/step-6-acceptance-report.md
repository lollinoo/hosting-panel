# Step 6 — Accounts, Password Reset and Support Access: Acceptance Report

This report grows with step 6. Every part below rests on test runs against in-process servers,
an in-memory database (PGlite) and the executor simulator; nothing here was run against the real
Docker Engine or on a production server.

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
