import dotenv from "dotenv";
dotenv.config({ path: new URL("../../.env", import.meta.url).pathname }); // repo-root .env, whatever the cwd
import Fastify from "fastify";
import { openDb, storeEvent } from "./db.js";
import { verifyWebhook } from "./paypal.js";

const db = openDb();
const app = Fastify({ logger: true });

// verify -> store (idempotent) -> 200. Processing happens off the request path.
app.post("/webhooks/paypal", async (req, reply) => {
  const ev = req.body as { id?: string; event_type?: string };
  const ok = ev?.id && req.headers["paypal-transmission-sig"] && (await verifyWebhook(req.headers, ev).catch(() => false));
  if (!ok) return reply.code(400).send({ error: "bad signature" });
  const fresh = storeEvent(db, ev.id!, String(ev.event_type), JSON.stringify(ev));
  if (fresh) app.log.info({ type: ev.event_type }, "webhook stored"); // ponytail: dispatch to case engine on day 3
  return { ok: true };
});

app.get("/health", async () => ({ ok: true }));
app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
