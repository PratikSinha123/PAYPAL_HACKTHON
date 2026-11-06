import { createClient, type Client } from "@libsql/client";

export function openDb(url = `file:${process.env.DB_PATH ?? "chargeguard.db"}`) {
  const db = createClient({ url });
  return db;
}
export type Db = Client;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  paypal_subscription_id TEXT PRIMARY KEY, customer_email TEXT, plan TEXT,
  status TEXT, next_billing TEXT, custom_id TEXT);
CREATE TABLE IF NOT EXISTS transactions (
  paypal_sale_id TEXT PRIMARY KEY, subscription_id TEXT, amount REAL, currency TEXT,
  status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY, subscription_id TEXT, source TEXT CHECK (source IN ('customer','paypal_dispute')),
  paypal_dispute_id TEXT UNIQUE, reason_code TEXT,
  status TEXT NOT NULL DEFAULT 'intake' CHECK (status IN
    ('intake','triaged','evidence_assembled','recommended','awaiting_approval','executing','resolved','escalated')),
  deadline TEXT, opened_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT, outcome TEXT);
CREATE TABLE IF NOT EXISTS evidence_items (
  id INTEGER PRIMARY KEY, case_id INTEGER REFERENCES cases(id), kind TEXT, label TEXT,
  present INTEGER NOT NULL DEFAULT 0, value TEXT);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY, case_id INTEGER REFERENCES cases(id),
  type TEXT CHECK (type IN ('SEND_BUYER_MESSAGE','ISSUE_REFUND','MAKE_OFFER','PROVIDE_EVIDENCE','ACCEPT_CLAIM','CANCEL_SUBSCRIPTION')),
  payload TEXT, proposed_by TEXT DEFAULT 'ai',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed')),
  approved_by TEXT, executed_at TEXT, paypal_response TEXT);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, case_id INTEGER REFERENCES cases(id),
  direction TEXT CHECK (direction IN ('in','out')), body TEXT, sent_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS webhook_events (
  paypal_event_id TEXT PRIMARY KEY, event_type TEXT, raw TEXT, processed_at TEXT);
`;

/** Initialize schema. Must be called once before using the db. */
export async function initDb(db: Db): Promise<void> {
  // libsql executeMultiple supports multiple statements
  await db.executeMultiple(SCHEMA);
}

/** Idempotent store: returns false if PayPal already delivered this event. */
export async function storeEvent(db: Db, id: string, type: string, raw: string): Promise<boolean> {
  const result = await db.execute({
    sql: "INSERT OR IGNORE INTO webhook_events (paypal_event_id, event_type, raw) VALUES (?,?,?)",
    args: [id, type, raw],
  });
  return result.rowsAffected === 1;
}
