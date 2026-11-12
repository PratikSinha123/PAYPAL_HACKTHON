import crypto from "node:crypto";
import type { Db } from "./db.js";
import { openCustomerCase, getCaseDetail, addMessage } from "./case-engine.js";

const SECRET = () => process.env.PORTAL_SECRET ?? "change-me";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Generate a signed, time-limited portal token for a subscription.
 * Format: subscriptionId:exp:hmac
 */
export function generatePortalToken(subscriptionId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${subscriptionId}:${exp}`;
  const hmac = crypto.createHmac("sha256", SECRET()).update(payload).digest("hex").slice(0, 16);
  return `${subscriptionId}:${exp}:${hmac}`;
}

/**
 * Verify and extract subscription ID from a portal token.
 * Enforces cryptographic HMAC signature and expiration timestamp.
 */
export function verifyPortalToken(token: string): string | null {
  const parts = token.split(":");

  // 1. New time-limited format: subscriptionId:exp:hmac
  if (parts.length === 3) {
    const [subscriptionId, expStr, hmac] = parts;
    const exp = Number(expStr);
    if (!subscriptionId || isNaN(exp) || !hmac) return null;

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (now > exp) {
      return null; // Expired!
    }

    const payload = `${subscriptionId}:${exp}`;
    const expected = crypto.createHmac("sha256", SECRET()).update(payload).digest("hex").slice(0, 16);
    if (hmac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
    return subscriptionId;
  }

  // 2. Legacy format: subscriptionId:hmac (fallback compatibility)
  if (parts.length === 2) {
    const [subscriptionId, hmac] = parts;
    if (!subscriptionId || !hmac) return null;
    const expected = crypto.createHmac("sha256", SECRET()).update(subscriptionId).digest("hex").slice(0, 16);
    if (hmac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
    return subscriptionId;
  }

  return null;
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
        `SELECT m.* FROM messages m JOIN cases c ON m.case_id = c.id WHERE c.subscription_id = ? AND m.status = 'sent' ORDER BY m.sent_at ASC`
      ).all(subscriptionId)
    : [];
  return { subscription, transactions, cases, messages: caseMessages };
}

// Re-export case-engine helpers used by portal routes
export { openCustomerCase, getCaseDetail, addMessage };
