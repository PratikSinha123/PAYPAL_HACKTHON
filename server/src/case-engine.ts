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

/** Propose an action for a case (AI or rules-generated) */
export function proposeAction(db: Db, caseId: number, type: string, payload: object, proposedBy = "ai"): number {
  const result = db.prepare(
    "INSERT INTO actions (case_id, type, payload, proposed_by) VALUES (?, ?, ?, ?)"
  ).run(caseId, type, JSON.stringify(payload), proposedBy);
  return Number(result.lastInsertRowid);
}

/** Approve an action — THE GATE. Only approved actions can execute. */
export function approveAction(db: Db, actionId: number, approvedBy = "owner"): void {
  const action = db.prepare("SELECT status FROM actions WHERE id = ?").get(actionId) as any;
  if (!action) throw new Error(`action ${actionId} not found`);
  if (action.status !== "pending") throw new Error(`action ${actionId} is ${action.status}, not pending`);
  db.prepare("UPDATE actions SET status = 'approved', approved_by = ? WHERE id = ?").run(approvedBy, actionId);
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
export function addEvidence(db: Db, caseId: number, kind: string, label: string, present: boolean, value?: string): number {
  const result = db.prepare(
    "INSERT INTO evidence_items (case_id, kind, label, present, value) VALUES (?, ?, ?, ?, ?)"
  ).run(caseId, kind, label, present ? 1 : 0, value ?? null);
  return Number(result.lastInsertRowid);
}

/** Store a message on a case thread */
export function addMessage(db: Db, caseId: number, direction: "in" | "out", body: string): number {
  const result = db.prepare(
    "INSERT INTO messages (case_id, direction, body) VALUES (?, ?, ?)"
  ).run(caseId, direction, body);
  return Number(result.lastInsertRowid);
}
