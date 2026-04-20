/**
 * DMCraft SMTP Worker — entry point.
 *
 * Responsibilities:
 *   - Boot HTTP server with /health and /trigger
 *   - Start the polling loop
 *   - Graceful shutdown on SIGTERM/SIGINT
 */

import express, { type Request, type Response } from "express";
import pino from "pino";
import { startPoller, pickAndProcess } from "./poller.js";

const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const NODE_ENV = process.env.NODE_ENV || "production";
const WEBHOOK_SECRET = (process.env.WORKER_WEBHOOK_SECRET || "").trim();

const log = pino({
  level: LOG_LEVEL,
  ...(NODE_ENV !== "production"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});

// ─── Sanity checks ──────────────────────────────────────────────────────────

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  log.fatal("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!process.env.OAUTH_ENCRYPTION_KEY) {
  log.fatal("Missing OAUTH_ENCRYPTION_KEY (required to decrypt SMTP passwords)");
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  log.warn("WORKER_WEBHOOK_SECRET not set — /trigger endpoint will reject all calls");
}

// ─── HTTP server ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.post("/trigger", async (req: Request, res: Response) => {
  const auth = req.header("authorization") || "";
  const expected = `Bearer ${WEBHOOK_SECRET}`;
  if (!WEBHOOK_SECRET || auth !== expected) {
    log.warn({ ip: req.ip }, "Unauthorized /trigger call");
    return res.status(401).json({ error: "unauthorized" });
  }

  const draftId = typeof req.body?.draftId === "string" ? req.body.draftId : null;
  if (!draftId) {
    return res.status(400).json({ error: "draftId required" });
  }

  log.info({ draftId }, "🎯 Manual trigger received");

  // Fire-and-forget: reply 202 immediately so caller (UI) is responsive
  res.status(202).json({ accepted: true, draftId });

  pickAndProcess(log, draftId).catch((err) => {
    log.error({ draftId, err: err?.message || String(err) }, "Manual trigger failed");
  });
});

const server = app.listen(PORT, () => {
  log.info({ port: PORT }, "🚀 Worker HTTP server listening");
});

// ─── Poller ─────────────────────────────────────────────────────────────────

const stopPoller = startPoller(log);

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(signal: string) {
  log.info({ signal }, "Shutting down...");
  stopPoller();
  server.close(() => {
    log.info("HTTP server closed. Bye.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  log.error({ reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  log.fatal({ err }, "Uncaught exception");
  process.exit(1);
});
