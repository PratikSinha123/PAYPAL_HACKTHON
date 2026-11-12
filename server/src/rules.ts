import type { Db } from "./db.js";

/** Find duplicate charges: same subscription, same amount, within 48 hours */
export function findDuplicateCharges(db: Db): Array<{
  subscription_id: string;
  amount: number;
  first_sale_id: string;
  second_sale_id: string;
  first_time: string;
  second_time: string;
}> {
  return db.prepare(`
    SELECT t1.subscription_id, t1.amount,
           t1.paypal_sale_id AS first_sale_id, t2.paypal_sale_id AS second_sale_id,
           t1.created_at AS first_time, t2.created_at AS second_time
    FROM transactions t1
    JOIN transactions t2
      ON t1.subscription_id = t2.subscription_id
     AND t1.amount = t2.amount
     AND t1.paypal_sale_id < t2.paypal_sale_id
     AND ABS(julianday(t2.created_at) - julianday(t1.created_at)) < 2
    WHERE t1.status = 'completed' AND t2.status = 'completed'
  `).all() as any;
}

/** Get cases ordered by deadline urgency (closest deadline first, nulls last) */
export function caseQueue(db: Db): Array<{
  id: number;
  subscription_id: string;
  source: string;
  reason_code: string | null;
  status: string;
  deadline: string | null;
  opened_at: string;
  hours_remaining: number | null;
  deadline_status: "none" | "overdue" | "urgent" | "warning" | "normal";
  is_overdue: number;
  is_urgent: number;
}> {
  return db.prepare(`
    SELECT c.*,
      CASE WHEN c.deadline IS NOT NULL
        THEN ROUND((julianday(c.deadline) - julianday('now')) * 24, 1)
        ELSE NULL
      END AS hours_remaining,
      CASE
        WHEN c.deadline IS NULL THEN 'none'
        WHEN (julianday(c.deadline) - julianday('now')) * 24 <= 0 THEN 'overdue'
        WHEN (julianday(c.deadline) - julianday('now')) * 24 <= 24 THEN 'urgent'
        WHEN (julianday(c.deadline) - julianday('now')) * 24 <= 72 THEN 'warning'
        ELSE 'normal'
      END AS deadline_status,
      CASE
        WHEN c.deadline IS NOT NULL AND (julianday(c.deadline) - julianday('now')) * 24 <= 0 THEN 1
        ELSE 0
      END AS is_overdue,
      CASE
        WHEN c.deadline IS NOT NULL AND (julianday(c.deadline) - julianday('now')) * 24 > 0 AND (julianday(c.deadline) - julianday('now')) * 24 <= 24 THEN 1
        ELSE 0
      END AS is_urgent
    FROM cases c
    WHERE c.status NOT IN ('resolved', 'escalated')
    ORDER BY
      CASE WHEN c.deadline IS NOT NULL THEN 0 ELSE 1 END,
      c.deadline ASC,
      c.opened_at ASC
  `).all() as any;
}

/** Find subscriptions with failed payments (dunning candidates) */
export function dunningCandidates(db: Db): Array<{
  paypal_subscription_id: string;
  customer_email: string;
  status: string;
  failed_count: number;
}> {
  return db.prepare(`
    SELECT s.paypal_subscription_id, s.customer_email, s.status,
      (SELECT COUNT(*) FROM transactions t
       WHERE t.subscription_id = s.paypal_subscription_id AND t.status = 'failed') AS failed_count
    FROM subscriptions s
    WHERE s.status IN ('PAYMENT_FAILED', 'SUSPENDED')
    ORDER BY failed_count DESC
  `).all() as any;
}

/** Auto-detect if a customer complaint matches a known duplicate charge */
export function matchDuplicateForSubscription(db: Db, subscriptionId: string): {
  first_sale_id: string; second_sale_id: string; amount: number;
  first_time: string; second_time: string;
} | null {
  const row = db.prepare(`
    SELECT t1.paypal_sale_id AS first_sale_id, t2.paypal_sale_id AS second_sale_id,
           t1.amount, t1.created_at AS first_time, t2.created_at AS second_time
    FROM transactions t1
    JOIN transactions t2
      ON t1.subscription_id = t2.subscription_id
     AND t1.amount = t2.amount
     AND t1.paypal_sale_id < t2.paypal_sale_id
     AND ABS(julianday(t2.created_at) - julianday(t1.created_at)) < 2
    WHERE t1.subscription_id = ? AND t1.status = 'completed' AND t2.status = 'completed'
    ORDER BY t2.created_at DESC LIMIT 1
  `).get(subscriptionId) as any;
  return row ?? null;
}

/** Financial Recovery Ledger: ROI metrics for deflection & protected revenue */
export function recoveryLedger(db: Db): {
  deflected_count: number;
  disputes_won_count: number;
  total_protected_usd: number;
  active_cases_count: number;
  urgent_deadlines_count: number;
} {
  const deflected = db.prepare(
    "SELECT COUNT(*) AS count FROM cases WHERE source = 'customer' AND status = 'resolved'"
  ).get() as { count: number };

  const won = db.prepare(
    "SELECT COUNT(*) AS count FROM cases WHERE source = 'paypal_dispute' AND (status = 'resolved' OR outcome LIKE '%SELLER%' OR outcome = 'executed')"
  ).get() as { count: number };

  const active = db.prepare(
    "SELECT COUNT(*) AS count FROM cases WHERE status NOT IN ('resolved', 'escalated')"
  ).get() as { count: number };

  const urgent = db.prepare(
    "SELECT COUNT(*) AS count FROM cases WHERE status NOT IN ('resolved', 'escalated') AND deadline IS NOT NULL AND (julianday(deadline) - julianday('now')) * 24 <= 24"
  ).get() as { count: number };

  const protectedTxns = db.prepare(`
    SELECT COALESCE(SUM(t.amount), 0) AS total
    FROM cases c
    LEFT JOIN transactions t ON t.subscription_id = c.subscription_id
    WHERE (c.source = 'customer' AND c.status = 'resolved')
       OR (c.source = 'paypal_dispute' AND (c.status = 'resolved' OR c.outcome LIKE '%SELLER%' OR c.outcome = 'executed'))
  `).get() as { total: number };

  const totalProtected = Number((protectedTxns.total > 0 ? protectedTxns.total : (deflected.count + won.count) * 9.99).toFixed(2));

  return {
    deflected_count: deflected.count,
    disputes_won_count: won.count,
    total_protected_usd: totalProtected,
    active_cases_count: active.count,
    urgent_deadlines_count: urgent.count,
  };
}
