/**
 * SMTP Sender — processes a single email_draft.
 *
 * Idempotency strategy:
 *   - Each draft is sent with a deterministic SMTP Message-ID:
 *       dmcraft-draft-<draftId>@dmcraft.local
 *   - This same value is stored in `emails.gmail_message_id`.
 *   - Before sending we check if a row with that Message-ID already exists.
 *     If yes → SMTP was already delivered in a previous run that crashed
 *     before persistence; we skip the send and finalize cleanup.
 *
 * Attachments storage (canonical):
 *   - Bucket: `email-attachments-outbox` (private)
 *   - Path:   `{tenant_id}/{draft_id}/{filename}`
 *   - Edge function `smtp-send` uploads here when creating the draft.
 *   - Worker downloads, sends, then deletes the folder on success.
 */

import nodemailer from "nodemailer";
import type { Logger } from "pino";
import { z } from "zod";
import { decryptToken } from "./crypto.js";
import { getSupabase } from "./supabase.js";

const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const BACKOFF_MINUTES = [2, 5, 10];
const ATTACHMENTS_BUCKET = "email-attachments-outbox";
const PUSH_NOTIFY_TIMEOUT_MS = 5_000;

// ─── Schemas ────────────────────────────────────────────────────────────────

const AttachmentRefSchema = z.object({
  filename: z.string(),
  // Either inline content OR a storage reference
  content_base64: z.string().optional(),
  storage_bucket: z.string().optional(),
  storage_path: z.string().optional(),
  mime_type: z.string().optional(),
  size_bytes: z.number().optional(),
});

const SendPayloadSchema = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  bcc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string(),
  html: z.string().optional(),
  text: z.string().optional(),
  body: z.string().optional(), // legacy alias
  attachments: z.array(AttachmentRefSchema).optional(),
  reply_to: z.string().optional(),
  in_reply_to: z.string().optional(),
  references: z.union([z.string(), z.array(z.string())]).optional(),
  thread_id: z.string().optional(),
}).passthrough();

export type DraftRow = {
  id: string;
  user_id: string;
  account_id: string;
  tenant_id: string;
  retry_count: number | null;
  send_payload: unknown;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Deterministic SMTP Message-ID for a given draft.
 * Used both as the actual Message-ID header AND as `gmail_message_id` in DB.
 * Same draft → same ID → strong idempotency.
 */
function deterministicMessageId(draftId: string): string {
  return `dmcraft-draft-${draftId}@dmcraft.local`;
}

async function loadAttachmentBuffer(
  ref: z.infer<typeof AttachmentRefSchema>,
  log: Logger,
): Promise<Buffer> {
  if (ref.content_base64) {
    return Buffer.from(ref.content_base64.replace(/\s/g, ""), "base64");
  }
  if (ref.storage_bucket && ref.storage_path) {
    const supabase = getSupabase();
    const { data, error } = await supabase.storage
      .from(ref.storage_bucket)
      .download(ref.storage_path);
    if (error || !data) {
      throw new Error(
        `Failed to download attachment ${ref.filename} from ${ref.storage_bucket}/${ref.storage_path}: ${error?.message}`,
      );
    }
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  throw new Error(`Attachment ${ref.filename} has neither content_base64 nor storage reference`);
}

/**
 * Best-effort cleanup of attachment files in the outbox bucket.
 * Never throws — failure is logged and ignored (storage TTL job will sweep eventually).
 */
async function cleanupAttachments(
  refs: z.infer<typeof AttachmentRefSchema>[],
  log: Logger,
) {
  const toDelete = refs
    .filter((r) => r.storage_bucket === ATTACHMENTS_BUCKET && r.storage_path)
    .map((r) => r.storage_path as string);

  if (toDelete.length === 0) return;

  try {
    const supabase = getSupabase();
    const { error } = await supabase.storage.from(ATTACHMENTS_BUCKET).remove(toDelete);
    if (error) {
      log.warn({ err: error.message, count: toDelete.length }, "Attachment cleanup failed (non-fatal)");
    } else {
      log.debug({ count: toDelete.length }, "Attachment files cleaned from storage");
    }
  } catch (err) {
    log.warn({ err }, "Attachment cleanup exception (non-fatal)");
  }
}

/**
 * Best-effort push notification with hard timeout.
 * Never blocks the main flow — wrapped in try/catch + AbortController.
 */
async function safePushNotify(
  payload: { userId: string; title: string; body: string; url?: string; type?: string },
  log: Logger,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_NOTIFY_TIMEOUT_MS);
  try {
    const supabase = getSupabase();
    await Promise.race([
      supabase.functions.invoke("push-notify", {
        body: { action: "send", ...payload },
      }),
      new Promise((_, reject) =>
        controller.signal.addEventListener("abort", () =>
          reject(new Error("push-notify timeout")),
        ),
      ),
    ]);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "push-notify failed (non-fatal)");
  } finally {
    clearTimeout(timer);
  }
}

// ─── Retry scheduling ───────────────────────────────────────────────────────

async function scheduleRetry(draft: DraftRow, errorMsg: string, log: Logger) {
  const supabase = getSupabase();
  const newRetryCount = (draft.retry_count || 0) + 1;

  if (newRetryCount >= MAX_RETRIES) {
    log.error({ draftId: draft.id, errorMsg, attempts: newRetryCount }, "Draft failed permanently");
    await supabase
      .from("email_drafts")
      .update({
        retry_status: "failed",
        retry_count: newRetryCount,
        retry_error: errorMsg,
      })
      .eq("id", draft.id);

    await safePushNotify(
      {
        userId: draft.user_id,
        title: "❌ Invio email fallito",
        body: `Email non inviata dopo ${newRetryCount} tentativi: ${errorMsg.slice(0, 120)}`,
        url: "/emails",
        type: "email",
      },
      log,
    );
    return;
  }

  const minutes = BACKOFF_MINUTES[newRetryCount - 1] || 10;
  const nextRetry = new Date(Date.now() + minutes * 60_000).toISOString();
  log.warn(
    { draftId: draft.id, attempt: newRetryCount, nextRetry, errorMsg },
    "Retry scheduled",
  );

  await supabase
    .from("email_drafts")
    .update({
      retry_status: "pending",
      retry_count: newRetryCount,
      retry_at: nextRetry,
      retry_error: errorMsg,
    })
    .eq("id", draft.id);
}

// ─── Persistence (used by both happy path AND idempotent recovery) ──────────

async function persistEmailRow(
  draft: DraftRow,
  payload: z.infer<typeof SendPayloadSchema>,
  account: { email_address: string; signature_html: string | null },
  messageId: string,
  toList: string[],
  ccList: string[],
  bccList: string[],
  finalHtml: string,
  log: Logger,
): Promise<{ id: string } | null> {
  const supabase = getSupabase();

  // Idempotency check: did we already insert this email in a previous run?
  const { data: existing } = await supabase
    .from("emails")
    .select("id")
    .eq("account_id", draft.account_id)
    .eq("gmail_message_id", messageId)
    .maybeSingle();

  if (existing?.id) {
    log.info({ emailId: existing.id }, "♻️  Email row already exists (idempotent recovery)");
    return existing;
  }

  const { data: emailRow, error } = await supabase
    .from("emails")
    .insert({
      account_id: draft.account_id,
      tenant_id: draft.tenant_id,
      sent_by_user_id: draft.user_id,
      direction: "outbound",
      gmail_message_id: messageId,
      gmail_thread_id: payload.thread_id || messageId,
      from_email: account.email_address,
      to_emails: toList,
      cc_emails: ccList.length ? ccList : null,
      bcc_emails: bccList.length ? bccList : null,
      subject: payload.subject,
      body_html: finalHtml,
      body_text: payload.text || null,
      received_at: new Date().toISOString(),
      is_read: true,
      labels: ["SENT"],
    })
    .select("id")
    .single();

  if (error || !emailRow) {
    log.error({ err: error?.message }, "Email row insert failed");
    return null;
  }
  return emailRow;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function processDraft(draft: DraftRow, log: Logger): Promise<void> {
  const supabase = getSupabase();
  const draftLog = log.child({ draftId: draft.id, accountId: draft.account_id });
  const messageId = deterministicMessageId(draft.id);

  draftLog.info({ messageId }, "📤 Draft picked up");

  // 1. Validate payload
  let payload: z.infer<typeof SendPayloadSchema>;
  try {
    payload = SendPayloadSchema.parse(draft.send_payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    draftLog.error({ err: msg }, "Invalid send_payload schema");
    await supabase
      .from("email_drafts")
      .update({ retry_status: "failed", retry_error: `Payload invalido: ${msg}` })
      .eq("id", draft.id);
    return;
  }

  // 2. Load account
  const { data: account, error: accountError } = await supabase
    .from("email_accounts")
    .select(
      "id, email_address, status, provider, smtp_host, smtp_port, smtp_use_tls, smtp_username, smtp_password_encrypted, signature_html",
    )
    .eq("id", draft.account_id)
    .maybeSingle();

  if (accountError || !account) {
    await scheduleRetry(draft, `Account non trovato: ${accountError?.message || "n/a"}`, draftLog);
    return;
  }

  if (account.status !== "active") {
    draftLog.error({ status: account.status }, "Account not active, marking failed");
    await supabase
      .from("email_drafts")
      .update({ retry_status: "failed", retry_error: `Account non attivo: ${account.status}` })
      .eq("id", draft.id);
    return;
  }

  if (!account.smtp_host || !account.smtp_port || !account.smtp_password_encrypted) {
    await scheduleRetry(draft, "Configurazione SMTP incompleta sull'account", draftLog);
    return;
  }

  const toList = toArray(payload.to);
  const ccList = toArray(payload.cc);
  const bccList = toArray(payload.bcc);
  const htmlBody = payload.html || payload.body || "";
  const finalHtml = account.signature_html
    ? `${htmlBody}<br/><br/>${account.signature_html}`
    : htmlBody;
  const attachmentRefs = payload.attachments || [];

  // ─── IDEMPOTENT RECOVERY ──────────────────────────────────────────────────
  // If an `emails` row with our deterministic Message-ID already exists,
  // SMTP was already delivered in a previous run that crashed before
  // finishing persistence/cleanup. Skip the send, finalize cleanup, exit.
  const { data: alreadySent } = await supabase
    .from("emails")
    .select("id")
    .eq("account_id", draft.account_id)
    .eq("gmail_message_id", messageId)
    .maybeSingle();

  if (alreadySent?.id) {
    draftLog.warn(
      { emailId: alreadySent.id },
      "♻️  Idempotent recovery: SMTP was already delivered in a previous run, finalizing cleanup",
    );
    await cleanupAttachments(attachmentRefs, draftLog);
    await supabase.from("email_drafts").delete().eq("id", draft.id);
    return;
  }

  // 3. Decrypt SMTP password
  let smtpPassword: string;
  try {
    smtpPassword = await decryptToken(account.smtp_password_encrypted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    draftLog.error({ err: msg }, "Failed to decrypt SMTP password");
    await scheduleRetry(draft, `Errore decrittazione password SMTP: ${msg}`, draftLog);
    return;
  }

  // 4. Build attachments
  const mailAttachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  const persistedAttachmentMeta: { filename: string; mime_type?: string; size_bytes: number; storage_path?: string }[] = [];

  for (const ref of attachmentRefs) {
    try {
      const buf = await loadAttachmentBuffer(ref, draftLog);
      mailAttachments.push({ filename: ref.filename, content: buf, contentType: ref.mime_type });
      persistedAttachmentMeta.push({
        filename: ref.filename,
        mime_type: ref.mime_type,
        size_bytes: buf.byteLength,
        storage_path: ref.storage_path,
      });
      draftLog.info(
        { filename: ref.filename, sizeKB: Math.round(buf.byteLength / 1024) },
        "Attachment loaded",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await scheduleRetry(draft, `Errore caricamento allegato ${ref.filename}: ${msg}`, draftLog);
      return;
    }
  }

  // 5. SMTP connect + send
  const port = Number(account.smtp_port);
  const useTls = account.smtp_use_tls !== false;
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port,
    secure: port === 465,
    requireTLS: useTls && port !== 465,
    auth: {
      user: account.smtp_username || account.email_address,
      pass: smtpPassword,
    },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });

  draftLog.info({ host: account.smtp_host, port }, "🔌 SMTP connecting");

  try {
    await transporter.sendMail({
      from: account.email_address,
      to: toList,
      cc: ccList.length ? ccList : undefined,
      bcc: bccList.length ? bccList : undefined,
      subject: payload.subject,
      html: finalHtml,
      text: payload.text,
      replyTo: payload.reply_to,
      inReplyTo: payload.in_reply_to,
      references: payload.references,
      messageId, // ← Deterministic ID = strong idempotency
      headers: { "X-DMCraft-Draft-ID": draft.id },
      attachments: mailAttachments.length ? mailAttachments : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    draftLog.error({ err: msg }, "❌ SMTP send failed");
    transporter.close();
    await scheduleRetry(draft, msg, draftLog);
    return;
  }
  transporter.close();

  draftLog.info({ messageId }, "✅ SMTP delivered");

  // 6. Persist email + attachments (idempotent)
  const emailRow = await persistEmailRow(
    draft,
    payload,
    account,
    messageId,
    toList,
    ccList,
    bccList,
    finalHtml,
    draftLog,
  );

  if (!emailRow) {
    // SMTP succeeded but DB insert failed — leave draft for next cycle.
    // Idempotency guard at top will prevent double SMTP send.
    draftLog.error("⚠️ Email sent but DB persistence failed — will retry persistence next cycle");
    await supabase
      .from("email_drafts")
      .update({
        retry_status: "pending",
        retry_at: new Date(Date.now() + 60_000).toISOString(),
        retry_error: "SMTP OK ma errore salvataggio DB — verrà riprovato",
      })
      .eq("id", draft.id);
    return;
  }

  // Insert attachment metadata (best-effort)
  if (persistedAttachmentMeta.length) {
    const rows = persistedAttachmentMeta.map((a, idx) => ({
      email_id: emailRow.id,
      filename: a.filename,
      mime_type: a.mime_type || null,
      size_bytes: a.size_bytes,
      storage_path: a.storage_path || null,
      gmail_attachment_id: `${messageId}-${idx}`,
    }));
    const { error: attErr } = await supabase.from("email_attachments").insert(rows);
    if (attErr) {
      draftLog.warn({ err: attErr.message }, "Attachment metadata insert failed (non-fatal)");
    }
  }

  // 7. Cleanup outbox storage + delete draft
  await cleanupAttachments(attachmentRefs, draftLog);
  await supabase.from("email_drafts").delete().eq("id", draft.id);
  draftLog.info("🗑️  Draft deleted, flow complete");

  // 8. Push notification (best-effort, hard timeout)
  await safePushNotify(
    {
      userId: draft.user_id,
      title: "📧 Email inviata",
      body: `"${payload.subject}" → ${toList[0] || ""}`,
      url: "/emails",
      type: "email",
    },
    draftLog,
  );
}
