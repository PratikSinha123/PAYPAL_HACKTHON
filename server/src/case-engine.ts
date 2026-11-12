import type { Db } from "./db.js";

/** Create a case from a customer portal complaint */
export function openCustomerCase(db: Db, subscriptionId: string, complaintText: string): number {
  const result = db.prepare(
    "INSERT INTO cases (subscription_id, source) VALUES (?, 'customer')"
  ).run(subscriptionId);
  const caseId = Number(result.lastInsertRowid);
  db.prepare(
    "INSERT INTO messages (case_id, direction, body) VALUES (?, 'in', ?)"
  ).run(caseId, complaintText);
  return caseId;
}

/** Create a case from a PayPal dispute webhook */
export function openDisputeCase(db: Db, subscriptionId: string | null, disputeId: string, reasonCode: string, deadline: string | null): number {
  // Check if a case already exists for this dispute
  const existing = db.prepare("SELECT id FROM cases WHERE paypal_dispute_id = ?").get(disputeId) as any;
  if (existing) return existing.id;

  const result = db.prepare(
    "INSERT INTO cases (subscription_id, source, paypal_dispute_id, reason_code, deadline) VALUES (?, 'paypal_dispute', ?, ?, ?)"
  ).run(subscriptionId, disputeId, reasonCode, deadline);
  return Number(result.lastInsertRowid);
}

/** Advance case status — enforces valid transitions */
export function advanceCase(db: Db, caseId: number, newStatus: string): void {
  const TRANSITIONS: Record<string, string[]> = {
    intake: ["triaged"],
    triaged: ["evidence_assembled"],
    evidence_assembled: ["recommended"],
    recommended: ["awaiting_approval"],
    awaiting_approval: ["executing", "escalated"],
    executing: ["resolved", "escalated"],
  };
  const current = db.prepare("SELECT status FROM cases WHERE id = ?").get(caseId) as any;
  if (!current) throw new Error(`case ${caseId} not found`);
  const allowed = TRANSITIONS[current.status];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new Error(`invalid transition: ${current.status} → ${newStatus}`);
  }

  db.prepare(
    `UPDATE cases SET status = ?${newStatus === "resolved" ? ", resolved_at = datetime('now')" : ""} WHERE id = ?`
  ).run(newStatus, caseId);
}

/** Validate an action payload per action type before it can reach the approval screen */
export function validateActionPayload(db: Db, caseId: number, type: string, payload: Record<string, any>): Record<string, any> {
  if (!payload || typeof payload !== "object") {
    throw new Error("Action payload must be a non-empty object");
  }

  const caseRow = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId) as any;
  if (!caseRow) throw new Error(`case ${caseId} not found`);

  switch (type) {
    case "ISSUE_REFUND": {
      if (!payload.sale_id || typeof payload.sale_id !== "string" || payload.sale_id.trim() === "") {
        throw new Error("Invalid refund payload: sale_id is required and must be a non-empty string");
      }

      if (typeof payload.amount !== "number" || isNaN(payload.amount) || payload.amount <= 0) {
        throw new Error(`Invalid refund payload: amount must be a positive number, received ${payload.amount}`);
      }

      // Check against recorded case transactions
      if (caseRow.subscription_id) {
        const matchingTxn = db.prepare(
          "SELECT amount, currency FROM transactions WHERE paypal_sale_id = ? AND subscription_id = ?"
        ).get(payload.sale_id, caseRow.subscription_id) as { amount: number; currency: string } | undefined;

        if (matchingTxn) {
          if (payload.amount > matchingTxn.amount) {
            throw new Error(
              `Invalid refund payload: refund amount $${payload.amount} exceeds transaction sale amount $${matchingTxn.amount}`
            );
          }
          if (!payload.currency) {
            payload.currency = matchingTxn.currency || "USD";
          }
        } else {
          // If transactions exist for this case, sale_id must belong to one of them
          const anyTxns = db.prepare(
            "SELECT paypal_sale_id FROM transactions WHERE subscription_id = ?"
          ).all(caseRow.subscription_id) as Array<{ paypal_sale_id: string }>;

          if (anyTxns.length > 0) {
            throw new Error(
              `Invalid refund payload: sale_id '${payload.sale_id}' does not match any transaction for subscription ${caseRow.subscription_id}`
            );
          }
        }
      }
      break;
    }

    case "CANCEL_SUBSCRIPTION": {
      if (caseRow.subscription_id) {
        if (payload.subscription_id && payload.subscription_id !== caseRow.subscription_id) {
          throw new Error(
            `Invalid cancellation payload: subscription_id '${payload.subscription_id}' does not match case subscription '${caseRow.subscription_id}'`
          );
        }
        payload.subscription_id = caseRow.subscription_id;
      }
      break;
    }

    case "SEND_BUYER_MESSAGE": {
      if (!payload.message || typeof payload.message !== "string" || payload.message.trim() === "") {
        throw new Error("Invalid message payload: message must be a non-empty string");
      }
      break;
    }

    case "MAKE_OFFER": {
      if (payload.offer_amount !== undefined) {
        if (typeof payload.offer_amount !== "number" || isNaN(payload.offer_amount) || payload.offer_amount <= 0) {
          throw new Error("Invalid offer payload: offer_amount must be a positive number");
        }
      }
      break;
    }
  }

  return payload;
}

/** Propose an action for a case (AI or rules-generated). Strictly validates payload. */
export function proposeAction(db: Db, caseId: number, type: string, payload: Record<string, any>, proposedBy = "ai"): number {
  const validatedPayload = validateActionPayload(db, caseId, type, payload);
  const result = db.prepare(
    "INSERT INTO actions (case_id, type, payload, proposed_by) VALUES (?, ?, ?, ?)"
  ).run(caseId, type, JSON.stringify(validatedPayload), proposedBy);
  return Number(result.lastInsertRowid);
}

/** Approve an action — THE GATE. Only approved actions can execute. */
export function approveAction(db: Db, actionId: number, approvedBy = "owner"): void {
  const action = db.prepare("SELECT status FROM actions WHERE id = ?").get(actionId) as any;
  if (!action) throw new Error(`action ${actionId} not found`);
  if (action.status !== "pending") throw new Error(`action ${actionId} is ${action.status}, not pending`);
  db.prepare("UPDATE actions SET status = 'approved', approved_by = ? WHERE id = ?").run(approvedBy, actionId);
}

/**
 * Owner edit made in the same click that approves. Only while pending. The edited text becomes what is
 * sent: the payload field the executor reads, and the reply shown in the thread.
 */
export function applyOwnerEdit(db: Db, actionId: number, message: string): void {
  const a = db.prepare("SELECT case_id, type, status, payload FROM actions WHERE id = ?").get(actionId) as any;
  if (!a) throw new Error(`action ${actionId} not found`);
  if (a.status !== "pending") throw new Error(`action ${actionId} is ${a.status}, not pending`);
  const text = String(message ?? "").trim();
  if (!text || text.length > 2000) throw new Error("message must be 1-2000 characters");
  const payload = JSON.parse(a.payload || "{}");
  if (a.type === "SEND_BUYER_MESSAGE") payload.message = text;
  else if (["ISSUE_REFUND", "MAKE_OFFER", "ACCEPT_CLAIM"].includes(a.type)) payload.note = text;
  db.prepare("UPDATE actions SET payload = ? WHERE id = ?").run(JSON.stringify(validateActionPayload(db, a.case_id, a.type, payload)), actionId);
  const m = db.prepare("SELECT id FROM messages WHERE case_id = ? AND direction = 'out' AND status = 'draft' ORDER BY id DESC LIMIT 1").get(a.case_id) as any;
  if (m) db.prepare("UPDATE messages SET body = ? WHERE id = ?").run(text, m.id);
  else addMessage(db, a.case_id, "out", text, "draft");
}

/** Reject an action */
export function rejectAction(db: Db, actionId: number): void {
  const action = db.prepare("SELECT status FROM actions WHERE id = ?").get(actionId) as any;
  if (!action) throw new Error(`action ${actionId} not found`);
  if (action.status !== "pending") throw new Error(`action ${actionId} is ${action.status}, not pending`);
  db.prepare("UPDATE actions SET status = 'rejected' WHERE id = ?").run(actionId);
}

/** Get full case detail including evidence, actions, messages */
export function getCaseDetail(db: Db, caseId: number) {
  const caseRow = db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId) as any;
  if (!caseRow) return null;
  const evidence = db.prepare("SELECT * FROM evidence_items WHERE case_id = ?").all(caseId);
  const actions = db.prepare("SELECT * FROM actions WHERE case_id = ? ORDER BY id DESC").all(caseId);
  const messages = db.prepare("SELECT * FROM messages WHERE case_id = ? ORDER BY sent_at ASC").all(caseId);
  const subscription = caseRow.subscription_id
    ? db.prepare("SELECT * FROM subscriptions WHERE paypal_subscription_id = ?").get(caseRow.subscription_id)
    : null;
  const transactions = caseRow.subscription_id
    ? db.prepare("SELECT * FROM transactions WHERE subscription_id = ? ORDER BY created_at DESC").all(caseRow.subscription_id)
    : [];

  // Compute hours remaining and urgency flags
  let hoursRemaining: number | null = null;
  let deadlineStatus: "none" | "overdue" | "urgent" | "warning" | "normal" = "none";
  let isOverdue = false;
  let isUrgent = false;

  if (caseRow.deadline) {
    hoursRemaining = Math.round(((new Date(caseRow.deadline).getTime() - Date.now()) / 3600000) * 10) / 10;
    if (hoursRemaining <= 0) {
      deadlineStatus = "overdue";
      isOverdue = true;
    } else if (hoursRemaining <= 24) {
      deadlineStatus = "urgent";
      isUrgent = true;
    } else if (hoursRemaining <= 72) {
      deadlineStatus = "warning";
    } else {
      deadlineStatus = "normal";
    }
  }

  return {
    ...caseRow,
    hours_remaining: hoursRemaining,
    deadline_status: deadlineStatus,
    is_overdue: isOverdue ? 1 : 0,
    is_urgent: isUrgent ? 1 : 0,
    evidence,
    actions,
    messages,
    subscription,
    transactions,
  };
}

/** Add an evidence item to a case */
export function addEvidence(
  db: Db,
  caseId: number,
  kind: string,
  label: string,
  present: boolean,
  value?: string,
  source: "auto" | "owner" = "owner"
): number {
  const result = db.prepare(
    "INSERT INTO evidence_items (case_id, kind, label, present, value, source) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(caseId, kind, label, present ? 1 : 0, value ?? null, source);
  return Number(result.lastInsertRowid);
}

/** Store a message on a case thread */
export function addMessage(db: Db, caseId: number, direction: "in" | "out", body: string, status: "sent" | "draft" = "sent"): number {
  const result = db.prepare(
    "INSERT INTO messages (case_id, direction, body, status) VALUES (?, ?, ?, ?)"
  ).run(caseId, direction, body, status);
  return Number(result.lastInsertRowid);
}
