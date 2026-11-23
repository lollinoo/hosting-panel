# Runbook — Notifications

Operator procedures for notifications (`ADR-0040`). Design record:
`docs/architecture/adr/0040-notifications.md`.

The panel tells the server administrator and each customer when an alert of **Amministrazione › Stato** opens and
when it closes: by email, with a webhook or on Telegram. The pages are **Amministrazione › Notifiche**
(`/admin/notifications`) and, for a customer, **Notifiche** in the account menu (`/account/notifications`).

The database commands below only read; run them as written:

```bash
cd / && sudo -u postgres psql -X -d hosting_panel -c "<query>"
```

## Scope and limits (read first)

- **Nothing is sent until someone turns a channel on.** There is no capability flag and no environment variable.
  With no channel on, the pass reads one row every two minutes and stops there.
- **What is told:** the alerts of the **Stato** page, when they open and when they close. Nothing else: no message
  for what went well (a finished backup, a finished install) and no event of an application.
- **Two scopes.** The server's channels hear all 17 kinds of alert. A customer's channels hear seven kinds, and only
  about that customer's sites: a site is not running, a backup failed or is incomplete, a restore left the site not
  restored, a certificate is about to expire or was not issued, an uploaded certificate is about to expire.
- **Who sets them.** The server's channels: a server administrator. A customer's channels: an owner of that customer
  (`notification.read`, `notification.manage`). A collaborator has no access, and a support visit does not carry
  these permissions: a server administrator cannot read or change a customer's channels from the panel.
- **Timing.** One pass every two minutes, the first one two minutes after `hp-api` starts. An alert is told at the
  second pass in a row that sees it, so a message leaves two to four minutes after the **Stato** page would show the
  alert. What opens and closes between two passes produces no message.
- **The API sends.** If `hp-api` is down, nothing is sent and nobody is told. To know that the server itself is off,
  watch it from outside.
- **At least once.** If the API stops between a send and the write of its outcome, the message goes again at the next
  start. A webhook body carries an `id` to recognise the double.
- **The panel does not read what the other side answers.** Of a webhook or Telegram call it keeps the HTTP status
  only. Why a receiver refused a message is in the receiver's own logs.
- **Secrets are never shown.** The address of a webhook, its signing key and a bot token are encrypted in the
  database; the page shows the host name of a webhook and the chat of a bot, nothing more. No command below prints
  them. Never paste one in a ticket or a chat.

## 1. Turn a channel on and send a test

1. Open the page of the scope. Each channel has its own card: **Email**, **Webhook**, **Telegram**.
2. Fill the card and tick the groups under **Avvisami per**:
   - **Email** (server): one to five addresses, one per line. A customer writes no address: the mail goes to the
     owners of the account, at the address they sign in with (at most 20).
   - **Webhook**: an address that starts with `https://` and has a DNS name, on any port. The signing key is
     optional (16 to 128 printable characters, no space).
   - **Telegram**: the token of a bot created with BotFather, and the chat: its number (a group's starts with a
     minus sign) or the public name of a channel, starting with `@`. The bot must be a member of the chat.
3. **Salva**. A webhook address is checked now: the save is refused when the address is not a public one
   («Questo indirizzo non si può usare…») or when its name cannot be found («Non riusciamo a trovare questo
   indirizzo…»). See procedure 2 for what «public» means.
4. **Invia un messaggio di prova**. It goes at once, on the channel as it is saved (also when the channel is off),
   and the page says whether it went. One test every thirty seconds per channel. On an email channel the test goes
   to every address; the answer reports the first that failed.
5. A channel turned on while alerts are open is told of them within four minutes, as if they opened then.

A field already saved (address, key, token) shows empty with «già impostato»: leave it empty to keep it.

## 2. Read why a message was not delivered

**Ultimi messaggi**, at the bottom of the page, lists the last 20 messages of the last thirty days with their
outcome: **In attesa di invio**, **Consegnato**, **Non consegnato** with the reason, the number of attempts and, for
a webhook or Telegram, the HTTP status received.

The same for every scope, without recipients:

```sql
select d.created_at, coalesce(c.organization_id, 'server') as scope, c.kind, d.test, d.status, d.attempts,
       d.problem, d.http_status, d.next_attempt_at
  from notification_deliveries d join notification_channels c on c.id = d.channel_id
 order by d.created_at desc limit 30
```

A failed send is tried again 2, 10 and 30 minutes after the message was written; one hour after it was written the
message is **Non consegnato** for good. A pass sends at most 20 messages; the rest wait for the next one.

| `problem` | What happened | What to do |
|---|---|---|
| `mail_not_configured` | Outbound mail is not set up on this server. | Procedure 4. |
| `mail_refused` | The mail relay did not accept the message. | **Amministrazione › Email** and the log of `hp_mail_relay` in **Amministrazione › Log**. |
| `address_not_allowed` | The name of the webhook now leads to an address the panel does not call: private, loopback, link-local, reserved, or one of this server's own addresses. | The DNS record of the receiver changed. Point it to a public address of another machine, or save a new address. |
| `unreachable` | The name does not resolve, nobody answers within five seconds, the port is closed, or the certificate is not valid for the name. | Check the receiver from another machine: `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<host>/`. If every webhook and Telegram fails: procedure 4. |
| `redirect` | The receiver answered with a redirect (3xx). The panel follows none. | Save the final address. |
| `rejected` | The receiver answered 4xx. | Webhook: the path or its key is wrong, or the receiver refuses the signature. Telegram: `401` or `404` is a wrong or revoked token, `400` or `403` a wrong chat or a bot that is not a member of it. |
| `server_error` | The receiver answered 5xx. | The fault is on the receiver's side; the panel tries again by itself. |
| `expired` | An hour passed without a successful send, or the message was waiting when the panel was restored on a new server. | Fix the cause shown by the earlier attempts; the next alert is a new message. |
| `channel_changed` | The channel was turned off, changed or removed before the send, or the mail address was taken off the list. | Nothing: the message was dropped on purpose. |

What the API logs about notifications holds no address, key or token, only that something failed:

```bash
journalctl -u hp-api --since "-2 hours" | grep -E 'notification_(pass|observe|send)_failed'
```

- `notification_observe_failed`: the pass could not read the alerts. Nothing opens and nothing closes; the messages
  that wait still go.
- `notification_send_failed`: a send broke in an unexpected way; it counts as `unreachable` and is tried again.
- `notification_pass_failed`: the whole pass failed, most often because the database did not answer. The next pass
  starts from what is stored.

## 3. Check a webhook's signature on the receiving side

The panel sends `POST` with `Content-Type: application/json` and a body like this (the events are the same facts
the text is written from):

```json
{
  "version": 1,
  "id": "<message id>",
  "sentAt": "2026-11-23T09:30:00.000Z",
  "audience": "server",
  "test": false,
  "subject": "…",
  "text": "…",
  "events": [{ "id": "<24 hex>", "kind": "disk_high", "state": "opened", "severity": "critical", "…": "…" }],
  "omitted": 0
}
```

- `events[].id` is the same in the event that opens an alert and in the one that closes it (`state` is `opened` or
  `closed`). `omitted` counts the events beyond fifty that the message does not carry.
- With a signing key the request carries `X-Hosting-Panel-Signature: t=<seconds>,v1=<hex>`, where `<hex>` is the
  HMAC-SHA256, with the key, of `<seconds>.<body>`: the seconds, a dot, and the body exactly as received, byte for
  byte (not parsed and written again).

To check one request by hand, with the body saved in `body.json`, the key in `$KEY` and the number after `t=` in
`$T`:

```bash
{ printf '%s.' "$T"; cat body.json; } | openssl dgst -sha256 -hmac "$KEY" -hex
```

The output must end with the value after `v1=`. A receiver should also refuse a `t` older than a few minutes and
ignore an `id` it has already seen.

To change a key: write the new one in **Chiave di firma** and save; **Togli la chiave di firma** removes it and the
next messages go unsigned.

## 4. Mail is not set up, or the server cannot go out on HTTPS

- **Mail.** The page says «L'invio della posta non è ancora impostato su questo server». Email messages wait and are
  tried again; after an hour they are not delivered. Set outbound mail up in **Amministrazione › Email** (README,
  «Email in uscita»). Webhook and Telegram do not need it.
- **HTTPS.** Webhook and Telegram need outbound TCP to the receiver's port (443 for Telegram) and DNS answers from
  the public resolvers the panel uses for its domain checks. From the server:

  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' https://api.telegram.org/
  ```

  A number means the server goes out. An error means a firewall or the provider blocks it: mail still works, and
  every webhook and Telegram message ends as `unreachable`.
- **A receiver on this server or on a private network cannot be used.** The panel refuses an address that resolves to
  one of this server's own addresses or to a private one, at save and at every send. Put the receiver on another
  machine with a public address.

## 5. A channel went quiet

1. Is there anything to tell? Open **Amministrazione › Stato**. An alert that is open and was already told is not
   told again; it is told again only if it goes from «attenzione» to «critico».
2. Is the channel on, and is the group ticked?

   ```sql
   select id, coalesce(organization_id, 'server') as scope, kind, enabled, groups, last_tested_at, updated_at
     from notification_channels order by 2, 3
   ```

3. What the channel was already told (`announced_at` empty: seen once, told at the next pass if still open):

   ```sql
   select channel_id, alert_key, severity, first_seen_at, announced_at
     from notification_channel_alerts order by first_seen_at
   ```

4. Is the pass running? `systemctl is-active hp-api`, then the three log events of procedure 2.
5. An alert about a site or a part of the panel is **not** told as closed while whoever reports it does not answer
   (the executor or Docker is down, or the site is deploying or in maintenance). It is told when the look comes back
   and the alert is gone.

## 6. Downgrade while a channel exists

`hp-update` refuses to install a release that does not know notifications while any channel exists, on or off, the
server's or a customer's (feature `notifications`, exit code 8): the older release sends nothing and nobody would be
told that the alerts went silent.

- To go back cleanly: remove every channel with **Rimuovi** on each card (the customers' ones are removed by their
  owners), then run the update again.
- `--allow-feature-loss` installs the older release anyway. The three tables stay in the database, untouched; nothing
  is sent until a release with notifications is installed again. After that upgrade the pass starts again from what
  each channel had been told: what closed in the meantime is told as closed, what opened is told as new, and a
  message that was waiting for more than an hour is closed as `expired`.

## 7. Restore the panel on a new server

After `hp-restore-panel` (README, «Il server è perso»), the restore SQL (`infra/linux/hp-restore-panel.sql`) deletes
what every channel was told and closes the messages that were waiting as not delivered (`expired`). The channels,
their encrypted secrets and the outcomes already written stay.

1. Within four minutes of the first start, the alerts open **on the new server** are told as new.
2. No alert of the old server is told as closed.
3. The secrets open only with the same `/etc/hosting-panel/secrets-master.key` the copy was made with (the restore
   procedure puts the keys back first). With another key every webhook and Telegram send ends as `unreachable`, with
   `notification_send_failed` in the log of `hp-api`: remove the channel with **Rimuovi** and set it again.
4. Send a test on each of the server's channels: the new server may have a different outbound address or firewall.

## 8. Turn notifications off

- One channel: clear **Invia i messaggi su questo canale** and save. The channel forgets what it was told and drops
  the messages that wait; nothing is said. Turned on again, the open alerts are new.
- One kind of alert: untick its group and save.
- For good: **Rimuovi**. The panel forgets the address, the key and the token, with the channel's messages.
- Everything on a server: remove every channel. With no channel left the pass does one read every two minutes.
