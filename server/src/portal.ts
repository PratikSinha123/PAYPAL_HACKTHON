import crypto from "node:crypto";
import type { Db } from "./db.js";
import { openCustomerCase, getCaseDetail, addMessage } from "./case-engine.js";

const SECRET = () => process.env.PORTAL_SECRET ?? "change-me";

/** Generate a portal token for a subscription. Token = subscriptionId:hmac */
export function generatePortalToken(subscriptionId: string): string {
  const hmac = crypto.createHmac("sha256", SECRET()).update(subscriptionId).digest("hex").slice(0, 16);
  return `${subscriptionId}:${hmac}`;
}

/** Verify and extract subscription ID from a portal token */
export function verifyPortalToken(token: string): string | null {
  const [subscriptionId, hmac] = token.split(":");
  if (!subscriptionId || !hmac) return null;
  const expected = crypto.createHmac("sha256", SECRET()).update(subscriptionId).digest("hex").slice(0, 16);
  if (hmac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
  return subscriptionId;
}

/** Get portal data: subscription info, payment history, open cases & messages */
export function getPortalData(db: Db, subscriptionId: string) {
  const subscription = db.prepare("SELECT * FROM subscriptions WHERE paypal_subscription_id = ?").get(subscriptionId) as any;
  const transactions = db.prepare(
    "SELECT * FROM transactions WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 12"
  ).all(subscriptionId);
  const cases = db.prepare(
    "SELECT * FROM cases WHERE subscription_id = ? ORDER BY opened_at DESC"
  ).all(subscriptionId) as any[];
  const caseMessages = cases.length > 0
    ? db.prepare(
        `SELECT m.* FROM messages m JOIN cases c ON m.case_id = c.id WHERE c.subscription_id = ? ORDER BY m.sent_at ASC`
      ).all(subscriptionId)
    : [];
  return { subscription, transactions, cases, messages: caseMessages };
}

// Re-export case-engine helpers used by portal routes
export { openCustomerCase, getCaseDetail, addMessage };
