import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
import Fastify from "fastify";
import { openDb, storeEvent } from "./db.js";
import { verifyWebhook } from "./paypal.js";
import { dispatch } from "./dispatcher.js";
import { openCustomerCase, getCaseDetail, approveAction, rejectAction } from "./case-engine.js";
import { executeAction } from "./executor.js";
import { generatePortalToken, verifyPortalToken, getPortalData } from "./portal.js";
import { caseQueue, findDuplicateCharges, dunningCandidates } from "./rules.js";
import { processCase } from "./ai-jobs.js";

const db = openDb();
const app = Fastify({ logger: true });

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
app.get("/portal/:token", async (req, reply) => {
  const { token } = req.params as { token: string };
  const sub = verifyPortalToken(token);
  if (!sub) return reply.code(403).send({ error: "invalid token" });
  return getPortalData(db, sub);
});

app.post("/portal/:token/report", async (req, reply) => {
  const { token } = req.params as { token: string };
  const sub = verifyPortalToken(token);
  if (!sub) return reply.code(403).send({ error: "invalid token" });
  const { message } = req.body as { message: string };
  const caseId = openCustomerCase(db, sub, message);
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
  const result = await processCase(db, Number(id));
  return result;
});

app.post("/api/actions/:id/approve", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params as { id: string };
  approveAction(db, Number(id));
  await executeAction(db, Number(id));
  return { ok: true };
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

app.post("/api/portal-token", async (req, reply) => {
  if (!ownerGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  const { subscription_id } = req.body as { subscription_id: string };
  return { token: generatePortalToken(subscription_id) };
});

/* ───── Startup: Auto-advance stranded intake cases ───── */
const stranded = db.prepare("SELECT id FROM cases WHERE status = 'intake'").all() as { id: number }[];
for (const c of stranded) {
  processCase(db, c.id).catch((err) => app.log.warn({ err, caseId: c.id }, "Auto-process intake case failed"));
}

/* ───── Start ───── */
app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
