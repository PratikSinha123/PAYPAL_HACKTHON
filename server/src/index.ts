import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { openDb, storeEvent } from "./db.js";
import { verifyWebhook } from "./paypal.js";
import { dispatch } from "./dispatcher.js";
import { openCustomerCase, getCaseDetail, approveAction, rejectAction, applyOwnerEdit } from "./case-engine.js";
import { executeAction } from "./executor.js";
import { generatePortalToken, verifyPortalToken, getPortalData } from "./portal.js";
import { caseQueue, findDuplicateCharges, dunningCandidates, recoveryLedger } from "./rules.js";
import { processCase, TONE_GUIDELINES, type MerchantTone } from "./ai-jobs.js";

const db = openDb();
const app = Fastify({ logger: true });

/* ───── Static files ───── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.register(fastifyStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/",
});

/* ───── CORS ───── */
app.addHook("preHandler", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "*");
  reply.header("Access-Control-Allow-Methods", "*");
});

app.options("/*", async (_req, reply) => {
  reply
    .header("Access-Control-Allow-Origin", "*")
    .header("Access-Control-Allow-Headers", "*")
    .header("Access-Control-Allow-Methods", "*")
    .code(204)
    .send();
});

/* ───── Webhook ───── */
// verify -> store (idempotent) -> dispatch -> 200
app.post("/webhooks/paypal", async (req, reply) => {
  const ev = req.body as { id?: string; event_type?: string };
  const ok =
    ev?.id &&
    req.headers["paypal-transmission-sig"] &&
    (await verifyWebhook(req.headers, ev).catch(() => false));
  if (!ok) return reply.code(400).send({ error: "bad signature" });
  const fresh = storeEvent(db, ev.id!, String(ev.event_type), JSON.stringify(ev));
  if (fresh) {
    app.log.info({ type: ev.event_type }, "webhook stored");
    await dispatch(db, ev.id!, String(ev.event_type), JSON.stringify(ev));
  }
  return { ok: true };
});

/* ───── Health ───── */
app.get("/health", async () => ({ ok: true }));

/* ───── Portal routes ───── */

app.post("/portal/:token/report", async (req, reply) => {
  const { token } = req.params as { token: string };
  const sub = verifyPortalToken(token);
  if (!sub) return reply.code(403).send({ error: "invalid token" });
  const message = (req.body as { message?: unknown } | null)?.message;
  if (typeof message !== "string" || !message.trim() || message.length > 2000) return reply.code(400).send({ error: "message required (max 2000 chars)" });
  const caseId = openCustomerCase(db, sub, message.trim());
  // Auto-run AI pipeline in background to triage, assemble evidence, and draft recommendation
  processCase(db, caseId).catch((err) => app.log.error({ err, caseId }, "AI case processing error"));
  return { case_id: caseId };
});

/* ───── Owner auth helper ───── */
function ownerGuard(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const pwd = process.env.OWNER_PASSWORD;
  if (!pwd) return false;
  return req.headers["x-owner-password"] === pwd;
}

/* ───── Owner API routes ───── */
app.get("/api/cases", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  return caseQueue(db);
});

app.get("/api/cases/:id", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  const detail = getCaseDetail(db, Number(id));
  if (!detail) return reply.code(404).send({ error: "not found" });
  return detail;
});

app.post("/api/cases/:id/process", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  const asked = (req.body as { tone?: string } | null)?.tone;
  const tone = asked && asked in TONE_GUIDELINES ? (asked as MerchantTone) : undefined; // ponytail: unknown tone = default tone
  const result = await processCase(db, Number(id), tone);
  return result;
});

app.post("/api/actions/:id/approve", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  const edited = (req.body as { message?: string } | null)?.message;
  try {
    const cur = db.prepare("SELECT status FROM actions WHERE id = ?").get(Number(id)) as { status: string } | undefined;
    if (!cur) return reply.code(404).send({ error: "not found" });
    if (cur.status === "approved") {
      // Approved earlier but the PayPal call failed: retry the execution, no second approval or edit.
    } else {
      if (edited !== undefined) applyOwnerEdit(db, Number(id), edited);
      approveAction(db, Number(id));
    }
  } catch (err: any) {
    return reply.code(409).send({ error: err?.message ?? "rejected" });
  }
  await executeAction(db, Number(id));
  // The executor swallows PayPal errors and leaves the action 'approved': report that honestly.
  const a = db.prepare("SELECT status, type, paypal_response, case_id FROM actions WHERE id = ?").get(Number(id)) as any;
  if (a.status !== "executed") return reply.code(502).send({ error: `PayPal call failed: ${a.paypal_response ?? "unknown error"}` });
  const c = db.prepare("SELECT paypal_dispute_id FROM cases WHERE id = ?").get(a.case_id) as any;
  return { ok: true, pushed_to_paypal: ["ISSUE_REFUND", "CANCEL_SUBSCRIPTION"].includes(a.type) || Boolean(c?.paypal_dispute_id) };
});

app.post("/api/actions/:id/reject", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  rejectAction(db, Number(id));
  return { ok: true };
});

app.get("/api/rules/duplicates", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  return findDuplicateCharges(db);
});

app.get("/api/rules/dunning", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  return dunningCandidates(db);
});

app.get("/api/ledger", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  return recoveryLedger(db);
});

app.post("/api/portal-token", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  const { subscription_id } = req.body as { subscription_id: string };
  return { token: generatePortalToken(subscription_id) };
});

/* ───── Portal API routes (with /api/ prefix for frontend) ───── */
app.get("/api/portal/:token", async (req, reply) => {
  const { token } = req.params as { token: string };
  const sub = verifyPortalToken(token);
  if (!sub) return reply.code(403).send({ error: "invalid token" });
  return getPortalData(db, sub);
});

/* ───── Portal HTML page (serves portal.html for browser visits) ───── */
app.get("/portal/:token", async (req, reply) => {
  const accept = req.headers.accept || "";
  // If it's a JSON API call, return data
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    const { token } = req.params as { token: string };
    const sub = verifyPortalToken(token);
    if (!sub) return reply.code(403).send({ error: "invalid token" });
    return getPortalData(db, sub);
  }
  // Otherwise serve the portal HTML page
  return reply.sendFile("portal.html");
});

/* ───── Startup: Auto-advance stranded intake cases ───── */
const stranded = db.prepare("SELECT id FROM cases WHERE status = 'intake'").all() as { id: number }[];
for (const c of stranded) {
  processCase(db, c.id).catch((err) => app.log.warn({ err, caseId: c.id }, "Auto-process intake case failed"));
}

/* ───── Start ───── */
app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
