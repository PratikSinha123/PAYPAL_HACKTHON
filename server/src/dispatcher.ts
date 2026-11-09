import type { Db } from "./db.js";

/**
 * Process a webhook event stored in webhook_events.
 * Resilient: logs errors but never throws.
 */
export function dispatch(db: Db, eventId: string, eventType: string, raw: string): void {
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

      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
        const subId = resource.id as string;
        db.prepare("UPDATE subscriptions SET status = 'PAYMENT_FAILED' WHERE paypal_subscription_id = ?").run(subId);

        // Create a case if no open case with same reason_code exists
        const existing = db.prepare(
          `SELECT id FROM cases
           WHERE subscription_id = ? AND reason_code = 'PAYMENT_FAILED'
             AND status NOT IN ('resolved', 'escalated')`
        ).get(subId) as any;

        if (!existing) {
          db.prepare(
            `INSERT INTO cases (subscription_id, source, reason_code)
             VALUES (?, 'paypal_dispute', 'PAYMENT_FAILED')`
          ).run(subId);
        }
        break;
      }

      /* ── Disputes ──────────────────────────────────────── */
      // CREATED can be missed (tunnel down), so CREATED and UPDATED both create-or-update the case.
      case "CUSTOMER.DISPUTE.CREATED":
      case "CUSTOMER.DISPUTE.UPDATED": {
        const disputeId = resource.dispute_id as string;
        const sellerTxnId = resource.disputed_transactions?.[0]?.seller_transaction_id as string | undefined;
        const reasonCode = (resource.reason as string | undefined) ?? null;
        const deadline = (resource.seller_response_due_date as string | undefined) ?? null;

        const subscriptionId = sellerTxnId
          ? ((db.prepare("SELECT subscription_id FROM transactions WHERE paypal_sale_id = ?").get(sellerTxnId) as any)?.subscription_id ?? null)
          : null;

        // COALESCE: a later UPDATED without a field must not wipe what we already have.
        // ponytail: chargeback stage stays an active case; only RESOLVED closes it.
        db.prepare(
          `INSERT INTO cases (subscription_id, source, paypal_dispute_id, reason_code, deadline)
           VALUES (?, 'paypal_dispute', ?, ?, ?)
           ON CONFLICT(paypal_dispute_id) DO UPDATE SET
             reason_code = COALESCE(excluded.reason_code, reason_code),
             deadline = COALESCE(excluded.deadline, deadline),
             subscription_id = COALESCE(subscription_id, excluded.subscription_id)`
        ).run(subscriptionId, disputeId, reasonCode, deadline);
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
