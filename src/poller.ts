/**
 * Poller — periodically picks pending drafts and processes them.
 *
 * Concurrency control:
 *   1. Atomic lock: conditional UPDATE pending → processing.
 *      Two worker instances can never pick the same draft.
 *
 *   2. Stale processing reaper: drafts stuck in `processing` for more than
 *      STALE_PROCESSING_MINUTES are re-queued to `pending` with a small
 *      retry penalty. This recovers from worker crashes mid-flight.
 *      Idempotency guard in sender.ts prevents double SMTP send.
 */

import type { Logger } from "pino";
import { getSupabase } from "./supabase.js";
import { processDraft, type DraftRow } from "./sender.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15_000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);
const STALE_PROCESSING_MINUTES = Number(process.env.STALE_PROCESSING_MINUTES || 10);

let running = false;
let stopRequested = false;

/**
 * Reaper: any draft stuck in `processing` for >STALE_PROCESSING_MINUTES is
 * considered orphaned (worker crashed mid-flight). Move it back to `pending`
 * so the next poll cycle picks it up. Idempotency in sender.ts ensures no
 * double SMTP send if the previous run actually delivered the email.
 */
async function reapStaleProcessing(log: Logger): Promise<number> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60_000).toISOString();

  const { data, error } = await supabase
    .from("email_drafts")
    .update({
      retry_status: "pending",
      retry_at: new Date().toISOString(),
      retry_error: `Recovery: ripreso da stato 'processing' bloccato >${STALE_PROCESSING_MINUTES}min`,
    })
    .eq("retry_status", "processing")
    .lte("updated_at", cutoff)
    .select("id");

  if (error) {
    log.warn({ err: error.message }, "Stale-processing reaper failed");
    return 0;
  }
  const count = data?.length || 0;
  if (count > 0) {
    log.warn({ count, draftIds: data!.map((d) => d.id) }, "♻️  Reaped stale processing drafts");
  }
  return count;
}

export async function pickAndProcess(log: Logger, targetDraftId?: string): Promise<number> {
  const supabase = getSupabase();

  let query = supabase
    .from("email_drafts")
    .select("id, user_id, account_id, tenant_id, retry_count, send_payload, retry_status");

  if (targetDraftId) {
    query = query.eq("id", targetDraftId).in("retry_status", ["pending", "processing", "failed"]);
  } else {
    query = query
      .eq("retry_status", "pending")
      .lte("retry_at", new Date().toISOString())
      .order("retry_at", { ascending: true })
      .limit(BATCH_SIZE);
  }

  const { data: candidates, error } = await query;

  if (error) {
    log.error({ err: error.message }, "Poller fetch error");
    return 0;
  }
  if (!candidates || candidates.length === 0) return 0;

  let processed = 0;

  for (const candidate of candidates) {
    // Atomic lock: only proceed if we win the race
    const { data: locked, error: lockError } = await supabase
      .from("email_drafts")
      .update({ retry_status: "processing" })
      .eq("id", candidate.id)
      .in("retry_status", targetDraftId ? ["pending", "processing", "failed"] : ["pending"])
      .select("id, user_id, account_id, tenant_id, retry_count, send_payload")
      .maybeSingle();

    if (lockError) {
      log.warn({ draftId: candidate.id, err: lockError.message }, "Lock failed");
      continue;
    }
    if (!locked) {
      log.debug({ draftId: candidate.id }, "Draft already locked by another worker");
      continue;
    }

    // For manual force-retry, reset retry_count so user gets full 3 fresh attempts
    if (targetDraftId) {
      await supabase
        .from("email_drafts")
        .update({ retry_count: 0, retry_error: null })
        .eq("id", candidate.id);
      (locked as DraftRow).retry_count = 0;
    }

    try {
      await processDraft(locked as DraftRow, log);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ draftId: candidate.id, err: msg }, "Unexpected error in processDraft");
      // Re-open for next poll cycle. Idempotency guard prevents double SMTP send.
      await supabase
        .from("email_drafts")
        .update({
          retry_status: "pending",
          retry_at: new Date(Date.now() + 60_000).toISOString(),
          retry_error: `Worker exception: ${msg}`,
        })
        .eq("id", candidate.id);
    }
  }

  return processed;
}

async function tick(log: Logger) {
  if (running) return;
  running = true;
  try {
    // Reap stale processing first so they become eligible in this same cycle
    await reapStaleProcessing(log);
    const n = await pickAndProcess(log);
    if (n > 0) log.info({ processed: n }, "Poller cycle complete");
  } catch (err) {
    log.error({ err }, "Poller tick failed");
  } finally {
    running = false;
  }
}

export function startPoller(log: Logger): () => void {
  log.info(
    { intervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, staleProcessingMinutes: STALE_PROCESSING_MINUTES },
    "🔄 Poller started",
  );

  tick(log).catch(() => undefined);

  const handle = setInterval(() => {
    if (stopRequested) return;
    tick(log).catch(() => undefined);
  }, POLL_INTERVAL_MS);

  return () => {
    stopRequested = true;
    clearInterval(handle);
    log.info("Poller stopped");
  };
}
