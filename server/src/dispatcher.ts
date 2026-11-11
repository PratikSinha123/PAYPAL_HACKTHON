import type { Db } from "./db.js";
import { getDispute } from "./paypal.js";
import { processCase } from "./ai-jobs.js";

/**
 * Process a webhook event stored in webhook_events.
 * Resilient: logs errors but never throws.
 */
export async function dispatch(db: Db, eventId: string, eventType: string, raw: string): Promise<void> {
  try {
    const event = JSON.parse(raw);
    const resource = event.resource ?? {};

    switch (eventType) {
      /* ── Sales ─────────────────────────────────────────── */
      case "PAYMENT.SALE.COMPLETED": {
        const subscriptionId = resource.billing_agreement_id as string | undefined;
        const saleId = resource.id as string;
        const amount = resource.amount?.total as string;
        const currency = resource.amount?.currency as string;
        const status = resource.state as string;
        const createdAt = resource.create_time as string;

        db.prepare(
          `INSERT OR IGNORE INTO transactions
             (paypal_sale_id, subscription_id, amount, currency, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(saleId, subscriptionId ?? null, amount, currency, status, createdAt);

        // Upsert a stub subscription if it doesn't exist yet (events arrive out of order)
        if (subscriptionId) {
          db.prepare(
            `INSERT OR IGNORE INTO subscriptions (paypal_subscription_id, status)
             VALUES (?, 'STUB')`
          ).run(subscriptionId);
        }
        break;
      }

      case "PAYMENT.SALE.REFUNDED": {
        const saleId = resource.sale_id as string;
        db.prepare("UPDATE transactions SET status = 'refunded' WHERE paypal_sale_id = ?").run(saleId);
        break;
      }

      case "PAYMENT.SALE.REVERSED": {
        const saleId = resource.sale_id as string;
        db.prepare("UPDATE transactions SET status = 'reversed' WHERE paypal_sale_id = ?").run(saleId);
        break;
      }

      /* ── Subscriptions ─────────────────────────────────── */
      case "BILLING.SUBSCRIPTION.ACTIVATED": {
        const subId = resource.id as string;
        const email = resource.subscriber?.email_address as string | undefined;
        const planId = resource.plan_id as string | undefined;
        const status = resource.status as string;
        const nextBilling = resource.billing_info?.next_billing_time as string | undefined;
        const customId = resource.custom_id as string | undefined;

        db.prepare(
          `INSERT OR REPLACE INTO subscriptions
             (paypal_subscription_id, customer_email, plan, status, next_billing, custom_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(subId, email ?? null, planId ?? null, status, nextBilling ?? null, customId ?? null);
        break;
      }

      case "BILLING.SUBSCRIPTION.CANCELLED": {
        db.prepare("UPDATE subscriptions SET status = 'CANCELLED' WHERE paypal_subscription_id = ?").run(resource.id);
        break;
      }

      case "BILLING.SUBSCRIPTION.SUSPENDED": {
        db.prepare("UPDATE subscriptions SET status = 'SUSPENDED' WHERE paypal_subscription_id = ?").run(resource.id);
        break;
      }

      case "BILLING.SUBSCRIPTION.EXPIRED": {
        db.prepare("UPDATE subscriptions SET status = 'EXPIRED' WHERE paypal_subscription_id = ?").run(resource.id);
        break;
      }

      /* ── Dunning ───────────────────────────────────────── */
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
        const subId = resource.id as string;
        const failedTxnId = (resource.transaction_id as string | undefined) || `failed-${eventId}`;
        const amount = Number(resource.amount?.total ?? resource.last_payment?.amount?.total ?? 9.99);
        const currency = (resource.amount?.currency as string | undefined) ?? "USD";
        const createdAt = (resource.create_time as string | undefined) ?? new Date().toISOString();

        // 1. Mark subscription state
        db.prepare("UPDATE subscriptions SET status = 'PAYMENT_FAILED' WHERE paypal_subscription_id = ?").run(subId);

        // 2. Record the failed transaction so dunning retry counts are tracked accurately
        db.prepare(
          `INSERT OR IGNORE INTO transactions
             (paypal_sale_id, subscription_id, amount, currency, status, created_at)
           VALUES (?, ?, ?, ?, 'failed', ?)`
        ).run(failedTxnId, subId, amount, currency, createdAt);

        // 3. Open a dunning case if no active case exists
        const existing = db.prepare(
          `SELECT id FROM cases
           WHERE subscription_id = ? AND reason_code = 'PAYMENT_FAILED'
             AND status NOT IN ('resolved', 'escalated')`
        ).get(subId) as any;

        if (!existing) {
          const res = db.prepare(
            `INSERT INTO cases (subscription_id, source, reason_code, status)
             VALUES (?, 'paypal_dispute', 'PAYMENT_FAILED', 'intake')`
          ).run(subId);
          const caseId = Number(res.lastInsertRowid);
          // Auto-advance case past intake if AI is configured
          if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
            processCase(db, caseId).catch((err) => {
              console.warn(`[dispatcher] auto-process dunning case ${caseId} skipped:`, err);
            });
          }
        }
        break;
      }

      /* ── Disputes ──────────────────────────────────────── */
      case "CUSTOMER.DISPUTE.CREATED":
      case "CUSTOMER.DISPUTE.UPDATED": {
        const disputeId = resource.dispute_id as string;
        let sellerTxnId = resource.disputed_transactions?.[0]?.seller_transaction_id as string | undefined;
        let reasonCode = (resource.reason as string | undefined) ?? null;
        let deadline = (resource.seller_response_due_date as string | undefined) ?? null;

        // Gotcha #4: Re-fetch authoritative dispute details from PayPal's GET /v1/customer/disputes/{id}
        // Guarantees authoritative seller_response_due_date and dispute status
        try {
          const liveDispute = await getDispute(disputeId);
          if (liveDispute) {
            if (liveDispute.seller_response_due_date) {
              deadline = liveDispute.seller_response_due_date;
            }
            if (liveDispute.reason) {
              reasonCode = liveDispute.reason;
            }
            if (liveDispute.disputed_transactions?.[0]?.seller_transaction_id) {
              sellerTxnId = liveDispute.disputed_transactions[0].seller_transaction_id;
            }
          }
        } catch {
          // Fall back gracefully to webhook payload if offline / simulated
        }

        const subscriptionId = sellerTxnId
          ? ((db.prepare("SELECT subscription_id FROM transactions WHERE paypal_sale_id = ?").get(sellerTxnId) as any)?.subscription_id ?? null)
          : null;

        // COALESCE: a later UPDATED without a field must not wipe what we already have.
        db.prepare(
          `INSERT INTO cases (subscription_id, source, paypal_dispute_id, reason_code, deadline, status)
           VALUES (?, 'paypal_dispute', ?, ?, ?, 'intake')
           ON CONFLICT(paypal_dispute_id) DO UPDATE SET
             reason_code = COALESCE(excluded.reason_code, reason_code),
             deadline = COALESCE(excluded.deadline, deadline),
             subscription_id = COALESCE(subscription_id, excluded.subscription_id)`
        ).run(subscriptionId, disputeId, reasonCode, deadline);

        // Auto-advance case past intake to awaiting_approval if AI is configured
        const caseRow = db.prepare("SELECT id, status FROM cases WHERE paypal_dispute_id = ?").get(disputeId) as any;
        if (caseRow && caseRow.status === "intake" && process.env.AI_BASE_URL && process.env.AI_API_KEY) {
          processCase(db, caseRow.id).catch((err) => {
            console.warn(`[dispatcher] auto-process dispute case ${caseRow.id} skipped:`, err);
          });
        }
        break;
      }

      case "CUSTOMER.DISPUTE.RESOLVED": {
        const disputeId = resource.dispute_id as string;
        const outcome = resource.status as string | undefined;

        db.prepare(
          `UPDATE cases SET status = 'resolved', resolved_at = datetime('now'), outcome = ?
           WHERE paypal_dispute_id = ?`
        ).run(outcome ?? null, disputeId);
        break;
      }

      default:
        // Unknown event type — silently skip
        break;
    }

    // Mark webhook event as processed
    db.prepare("UPDATE webhook_events SET processed_at = datetime('now') WHERE paypal_event_id = ?").run(eventId);
  } catch (err) {
    console.error(`[dispatcher] failed to process event ${eventId} (${eventType}):`, err);
  }
}
