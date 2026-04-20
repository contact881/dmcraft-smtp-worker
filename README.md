# DMCraft SMTP Worker

Persistent Node.js worker that processes the `email_drafts` queue and sends
emails via SMTP **without the CPU/RAM limits of edge functions**. Built to
guarantee deterministic delivery of normal-size attachments (PDF voucher,
rooming list, contracts, ≥4 MB).

---

## Architecture

```
Lovable Cloud (edge)              Railway (this worker)
─────────────────────             ────────────────────────────
smtp-send →  email_drafts  ───→   Poller (every 15s)
                                  → Sender (nodemailer, no limits)
                                  → emails + email_attachments
                                  → DELETE draft + push notify
```

- **Poller**: every `POLL_INTERVAL_MS` selects up to `BATCH_SIZE` drafts
  with `retry_status = 'pending'` and `retry_at <= now()`. Atomic lock via
  conditional `UPDATE … WHERE retry_status = 'pending'` so multiple worker
  instances cannot pick the same draft.
- **Sender**: decrypts SMTP password, downloads attachments from Supabase
  Storage, sends via nodemailer, persists into `emails` /
  `email_attachments`, deletes the draft.
- **Webhook**: `POST /trigger {draftId}` — invoked by edge functions or the
  UI "Riprova ora" button to process a single draft immediately.

---

## Local development

### 1. Install dependencies

```bash
cd worker
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in:
#   SUPABASE_URL                 (already set in example)
#   SUPABASE_SERVICE_ROLE_KEY    (from Lovable Cloud → Backend → API)
#   OAUTH_ENCRYPTION_KEY         (MUST match the value used by edge functions)
#   WORKER_WEBHOOK_SECRET        (random — `openssl rand -base64 32`)
```

> ⚠️ `OAUTH_ENCRYPTION_KEY` MUST be byte-identical to the secret configured
> in Lovable Cloud, otherwise SMTP passwords cannot be decrypted.

### 3. Run

```bash
npm run dev      # hot reload via tsx watch
# or
npm run build && npm start
```

You should see:

```
🚀 Worker HTTP server listening { port: 3000 }
🔄 Poller started { intervalMs: 15000, batchSize: 5 }
```

Health check:

```bash
curl http://localhost:3000/health
# {"status":"ok","uptime":12.34}
```

---

## Testing a real draft

### A) Let the poller pick it up

1. From the DMCraft UI, send an email with an attachment.
   The edge function `smtp-send` will create a row in `email_drafts` with
   `retry_status = 'pending'`.
2. Wait up to `POLL_INTERVAL_MS` (default 15s).
3. Watch the worker logs (see "Log expectations" below).

### B) Force immediate processing via webhook

```bash
curl -X POST http://localhost:3000/trigger \
  -H "Authorization: Bearer $WORKER_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"draftId":"<uuid-of-draft>"}'
# {"accepted":true,"draftId":"<uuid>"}
```

The worker replies `202 Accepted` immediately and processes async.

---

## Log expectations

### ✅ Successful send

```
📤 Draft picked up                       draftId=… accountId=…
Attachment loaded                         filename=voucher.pdf sizeKB=4123
🔌 SMTP connecting                        host=smtp.ionos.it port=465
✅ SMTP delivered                         messageId=<…@smtp.ionos.it>
🗑️  Draft deleted, flow complete
Poller cycle complete                     processed=1
```

### ❌ Transient failure (will retry)

```
📤 Draft picked up
🔌 SMTP connecting
❌ SMTP send failed                       err="Connection timeout"
Retry scheduled                           attempt=1 nextRetry=2026-04-19T11:23:00Z
```

After backoff (`+2min`, `+5min`, `+10min`) the poller picks it up again.

### 💀 Permanent failure (after 3 retries)

```
Draft failed permanently                  attempts=3 errorMsg="Invalid credentials"
```

The draft is set to `retry_status = 'failed'` and a push notification is
sent to the user. The draft stays visible in the UI so the operator can
inspect and click "Riprova ora" if desired.

---

## Deployment to Railway

1. Push this `/worker` folder to a **separate** GitHub repo
   `dmcraft-smtp-worker`.
2. On Railway: **New Project → Deploy from GitHub** → select repo.
3. **Settings → Region**: `eu-west` (Frankfurt).
4. **Variables**: add all entries from `.env.example`.
5. **Build command**: `npm install && npm run build`
6. **Start command**: `npm start`
7. **Healthcheck path**: `/health`
8. After deploy, copy the public URL (e.g.
   `https://dmcraft-smtp-worker.up.railway.app`) and configure it in
   Lovable Cloud as `WORKER_WEBHOOK_URL`.

---

## Environment variables

| Name                        | Required | Default | Notes                                          |
| --------------------------- | :------: | ------- | ---------------------------------------------- |
| `SUPABASE_URL`              | ✅       | —       | Lovable Cloud project URL                      |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅       | —       | Service role (full DB + Storage access)        |
| `OAUTH_ENCRYPTION_KEY`      | ✅       | —       | Must match edge function secret exactly        |
| `WORKER_WEBHOOK_SECRET`     | ✅       | —       | Bearer token for `/trigger`                    |
| `PORT`                      |          | `3000`  | HTTP port                                      |
| `POLL_INTERVAL_MS`          |          | `15000` | Polling frequency                              |
| `BATCH_SIZE`                |          | `5`     | Max drafts processed per cycle                 |
| `MAX_RETRIES`               |          | `3`     | Attempts before marking `failed`               |
| `STALE_PROCESSING_MINUTES`  |          | `10`    | Reaper threshold for orphaned `processing` rows |
| `LOG_LEVEL`                 |          | `info`  | `trace` / `debug` / `info` / `warn` / `error`  |
| `NODE_ENV`                  |          | `production` | Set to `development` for pretty logs       |

---

## Reliability guarantees

### 1. Stale processing recovery
A reaper runs every poll cycle: any draft stuck in `processing` for more
than `STALE_PROCESSING_MINUTES` (default 10) is automatically returned to
`pending` and re-picked. Recovers from worker crashes mid-flight.

### 2. Strong idempotency (no double sends)
Each draft gets a **deterministic SMTP Message-ID**:
`dmcraft-draft-<draftId>@dmcraft.local`. The same value is stored in
`emails.gmail_message_id`. Before sending, the worker checks if a row with
that ID already exists — if yes, SMTP was already delivered in a previous
run and we skip the send, finalizing only persistence/cleanup.

Additionally every email carries a custom header `X-DMCraft-Draft-ID:
<draftId>` for downstream tracing.

### 3. Attachment storage (canonical)
- **Bucket:** `email-attachments-outbox` (private)
- **Path:** `{tenant_id}/{draft_id}/{filename}`
- Edge function `smtp-send` uploads here when creating a draft.
- Worker downloads, sends, and **deletes the folder on success**.
- On permanent failure, files remain (for debugging) and a storage TTL job
  sweeps them after N days.

### 4. push-notify is best-effort
Push notifications are wrapped in try/catch + AbortController with a hard
**5s timeout**. They can never block or fail the main delivery flow.

---

## Security

- Only `/health` and `/trigger` are exposed.
- `/trigger` requires `Authorization: Bearer <WORKER_WEBHOOK_SECRET>`.
- SMTP passwords are decrypted in memory only — never logged.
- Service role key never leaves env.
