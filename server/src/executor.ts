import type { Db } from "./db.js";
import { paypal } from "./paypal.js";

/** Execute a single approved action. This is the only place PayPal write endpoints are called. */
export async function executeAction(db: Db, actionId: number): Promise<void> {
  const action = db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId) as any;
  if (!action) throw new Error(`action ${actionId} not found`);
  if (action.status !== "approved") throw new Error(`action ${actionId} is '${action.status}', not 'approved'. THE GATE HOLDS.`);

  // Also advance the case to 'executing' if it's in awaiting_approval
  const caseRow = db.prepare("SELECT status FROM cases WHERE id = ?").get(action.case_id) as any;
  if (caseRow?.status === "awaiting_approval") {
    db.prepare("UPDATE cases SET status = 'executing' WHERE id = ?").run(action.case_id);
  }

  const payload = JSON.parse(action.payload || "{}");
  let response: unknown;

  try {
    switch (action.type) {
      case "SEND_BUYER_MESSAGE": {
        // Send message during inquiry stage
        const disputeId = db.prepare("SELECT paypal_dispute_id FROM cases WHERE id = ?").get(action.case_id) as any;
        if (disputeId?.paypal_dispute_id) {
          response = await paypal(`/v1/customer/disputes/${disputeId.paypal_dispute_id}/send-message`, {
            method: "POST",
            body: JSON.stringify({ message: payload.message }),
          });
        }
        break;
      }
      case "ISSUE_REFUND": {
        response = await paypal(`/v1/payments/sale/${payload.sale_id}/refund`, {
          method: "POST",
          body: JSON.stringify({
            amount: payload.amount ? { total: payload.amount, currency: payload.currency ?? "USD" } : undefined,
            note_to_payer: payload.note ?? "Refund processed by ChargeGuard",
          }),
        });
        break;
      }
      case "MAKE_OFFER": {
        const disputeId = db.prepare("SELECT paypal_dispute_id FROM cases WHERE id = ?").get(action.case_id) as any;
        if (disputeId?.paypal_dispute_id) {
          response = await paypal(`/v1/customer/disputes/${disputeId.paypal_dispute_id}/make-offer`, {
            method: "POST",
            body: JSON.stringify({
              note: payload.note,
              offer_type: payload.offer_type ?? "REFUND",
              offer_amount: payload.offer_amount,
            }),
          });
        }
        break;
      }
      case "PROVIDE_EVIDENCE": {
        const disputeId = db.prepare("SELECT paypal_dispute_id FROM cases WHERE id = ?").get(action.case_id) as any;
        if (disputeId?.paypal_dispute_id) {
          // PayPal Disputes API expects { evidences: [{ evidence_type, notes }] }
          const notesText =
            typeof payload.evidence === "string"
              ? payload.evidence
              : payload.notes || payload.dispute_evidence_text || JSON.stringify(payload.evidence ?? "Merchant evidence submitted");
          const evidenceType = payload.evidence_type ?? "OTHER";

          response = await paypal(`/v1/customer/disputes/${disputeId.paypal_dispute_id}/provide-evidence`, {
            method: "POST",
            body: JSON.stringify({
              evidences: [
                {
                  evidence_type: evidenceType,
                  notes: notesText,
                },
              ],
            }),
          });
        }
        break;
      }
      case "ACCEPT_CLAIM": {
        const disputeId = db.prepare("SELECT paypal_dispute_id FROM cases WHERE id = ?").get(action.case_id) as any;
        if (disputeId?.paypal_dispute_id) {
          response = await paypal(`/v1/customer/disputes/${disputeId.paypal_dispute_id}/accept-claim`, {
            method: "POST",
            body: JSON.stringify({ note: payload.note ?? "Claim accepted" }),
          });
        }
        break;
      }
      case "CANCEL_SUBSCRIPTION": {
        response = await paypal(`/v1/billing/subscriptions/${payload.subscription_id}/cancel`, {
          method: "POST",
          body: JSON.stringify({ reason: payload.reason ?? "Cancelled via ChargeGuard" }),
        });
        break;
      }
    }

    // Only now is it executed: PayPal accepted the call.
    db.prepare("UPDATE actions SET status = 'executed', executed_at = datetime('now'), paypal_response = ? WHERE id = ?").run(JSON.stringify(response ?? null), actionId);

    // The reply reaches the customer only now: publish the approved draft (or the payload text) to the thread.
    if (["SEND_BUYER_MESSAGE", "ISSUE_REFUND", "MAKE_OFFER", "ACCEPT_CLAIM"].includes(action.type)) {
      const published = db.prepare("UPDATE messages SET status = 'sent', sent_at = datetime('now') WHERE case_id = ? AND direction = 'out' AND status = 'draft'").run(action.case_id).changes;
      if (!published && action.type === "SEND_BUYER_MESSAGE" && payload.message)
        db.prepare("INSERT INTO messages (case_id, direction, body, status) VALUES (?, 'out', ?, 'sent')").run(action.case_id, payload.message);
    }

    // Resolve the case
    db.prepare("UPDATE cases SET status = 'resolved', resolved_at = datetime('now'), outcome = 'executed' WHERE id = ? AND status = 'executing'").run(action.case_id);

  } catch (err: any) {
    // Store error but don't roll back the execution status
    db.prepare("UPDATE actions SET paypal_response = ? WHERE id = ?").run(JSON.stringify({ error: err.message }), actionId);
    console.error(`action ${actionId} execution failed:`, err.message);
    // Keep the case in the owner's queue with the action still 'approved', so the call can be retried.
    db.prepare("UPDATE cases SET status = 'awaiting_approval' WHERE id = ? AND status = 'executing'").run(action.case_id);
  }
}
