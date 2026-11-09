import assert from "node:assert/strict";
import { openDb, storeEvent } from "./db.js";
import { dispatch } from "./dispatcher.js";
import {
  openCustomerCase,
  advanceCase,
  proposeAction,
  approveAction,
  rejectAction,
  getCaseDetail,
  addEvidence,
  addMessage,
} from "./case-engine.js";
import { findDuplicateCharges, caseQueue, dunningCandidates, matchDuplicateForSubscription } from "./rules.js";
import { generatePortalToken, verifyPortalToken, getPortalData } from "./portal.js";

const db = openDb(":memory:");

// ─── Dispatcher tests ───

// Test PAYMENT.SALE.COMPLETED
const saleEvent = {
  id: "WH-SALE-1",
  event_type: "PAYMENT.SALE.COMPLETED",
  resource: {
    id: "SALE-001",
    billing_agreement_id: "I-SUB001",
    amount: { total: "9.99", currency: "USD" },
    state: "completed",
    create_time: "2026-11-07T10:00:00Z",
  },
};
storeEvent(db, saleEvent.id, saleEvent.event_type, JSON.stringify(saleEvent));
await dispatch(db, saleEvent.id, saleEvent.event_type, JSON.stringify(saleEvent));

// Verify transaction was stored
const tx = db.prepare("SELECT * FROM transactions WHERE paypal_sale_id = 'SALE-001'").get() as any;
assert.ok(tx, "transaction should exist after SALE.COMPLETED");
assert.equal(tx.amount, 9.99);
assert.equal(tx.subscription_id, "I-SUB001");
console.log("✓ PAYMENT.SALE.COMPLETED dispatched");

// Verify subscription was upserted (out-of-order handling)
const sub = db.prepare("SELECT * FROM subscriptions WHERE paypal_subscription_id = 'I-SUB001'").get() as any;
assert.ok(sub, "subscription should be upserted even without ACTIVATED event");
console.log("✓ Out-of-order subscription upsert");

// Test BILLING.SUBSCRIPTION.ACTIVATED (arrives after sale)
const activatedEvent = {
  id: "WH-ACT-1",
  event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
  resource: {
    id: "I-SUB001",
    subscriber: { email_address: "buyer@test.com" },
    plan_id: "P-PLAN001",
    status: "ACTIVE",
    billing_info: { next_billing_time: "2026-12-07T10:00:00Z" },
    custom_id: "cg-test-001",
  },
};
storeEvent(db, activatedEvent.id, activatedEvent.event_type, JSON.stringify(activatedEvent));
await dispatch(db, activatedEvent.id, activatedEvent.event_type, JSON.stringify(activatedEvent));

const subAfter = db.prepare("SELECT * FROM subscriptions WHERE paypal_subscription_id = 'I-SUB001'").get() as any;
assert.equal(subAfter.customer_email, "buyer@test.com");
assert.equal(subAfter.status, "ACTIVE");
console.log("✓ BILLING.SUBSCRIPTION.ACTIVATED dispatched");

// Test second sale for duplicate detection
const saleEvent2 = {
  id: "WH-SALE-2",
  event_type: "PAYMENT.SALE.COMPLETED",
  resource: {
    id: "SALE-002",
    billing_agreement_id: "I-SUB001",
    amount: { total: "9.99", currency: "USD" },
    state: "completed",
    create_time: "2026-11-07T11:00:00Z", // 1 hour later
  },
};
storeEvent(db, saleEvent2.id, saleEvent2.event_type, JSON.stringify(saleEvent2));
await dispatch(db, saleEvent2.id, saleEvent2.event_type, JSON.stringify(saleEvent2));
console.log("✓ Second sale stored");

// Test CUSTOMER.DISPUTE.CREATED
const disputeEvent = {
  id: "WH-DISP-1",
  event_type: "CUSTOMER.DISPUTE.CREATED",
  resource: {
    dispute_id: "PP-D-001",
    disputed_transactions: [{ seller_transaction_id: "SALE-001" }],
    reason: "DUPLICATE_TRANSACTION",
    dispute_life_cycle_stage: "INQUIRY",
    seller_response_due_date: new Date(Date.now() + 12 * 3600000).toISOString(), // 12 hours away (URGENT)
  },
};
storeEvent(db, disputeEvent.id, disputeEvent.event_type, JSON.stringify(disputeEvent));
await dispatch(db, disputeEvent.id, disputeEvent.event_type, JSON.stringify(disputeEvent));

const disputeCase = db.prepare("SELECT * FROM cases WHERE paypal_dispute_id = 'PP-D-001'").get() as any;
assert.ok(disputeCase, "case should be created for dispute");
assert.equal(disputeCase.source, "paypal_dispute");
assert.equal(disputeCase.reason_code, "DUPLICATE_TRANSACTION");
console.log("✓ CUSTOMER.DISPUTE.CREATED dispatched");

// Test CUSTOMER.DISPUTE.RESOLVED
const resolvedEvent = {
  id: "WH-DISP-R",
  event_type: "CUSTOMER.DISPUTE.RESOLVED",
  resource: {
    dispute_id: "PP-D-001",
    status: "RESOLVED_SELLER_FAVOUR",
  },
};
storeEvent(db, resolvedEvent.id, resolvedEvent.event_type, JSON.stringify(resolvedEvent));
await dispatch(db, resolvedEvent.id, resolvedEvent.event_type, JSON.stringify(resolvedEvent));

const resolvedCase = db.prepare("SELECT * FROM cases WHERE paypal_dispute_id = 'PP-D-001'").get() as any;
assert.equal(resolvedCase.status, "resolved");
assert.equal(resolvedCase.outcome, "RESOLVED_SELLER_FAVOUR");
console.log("✓ CUSTOMER.DISPUTE.RESOLVED dispatched");

// Test webhook processed_at is set
const processedEvent = db.prepare("SELECT processed_at FROM webhook_events WHERE paypal_event_id = 'WH-SALE-1'").get() as any;
assert.ok(processedEvent.processed_at, "processed_at should be set");
console.log("✓ webhook processed_at set");

// ─── Case engine tests ───

const caseId = openCustomerCase(db, "I-SUB001", "I think I was charged twice");
assert.ok(caseId > 0, "case should have a positive id");
const detail = getCaseDetail(db, caseId);
assert.ok(detail, "case detail should exist");
assert.equal(detail.status, "intake");
assert.equal(detail.messages.length, 1);
assert.equal((detail.messages[0] as any).body, "I think I was charged twice");
console.log("✓ openCustomerCase + getCaseDetail");

// Test state machine transitions
advanceCase(db, caseId, "triaged");
assert.equal((db.prepare("SELECT status FROM cases WHERE id = ?").get(caseId) as any).status, "triaged");
advanceCase(db, caseId, "evidence_assembled");
advanceCase(db, caseId, "recommended");
advanceCase(db, caseId, "awaiting_approval");
console.log("✓ Case state machine transitions");

// Test invalid transition
assert.throws(() => advanceCase(db, caseId, "intake"), /invalid transition/);
console.log("✓ Invalid transitions rejected");

// Test actions & THE GATE
const actionId = proposeAction(db, caseId, "ISSUE_REFUND", { sale_id: "SALE-002", amount: 9.99 });
assert.ok(actionId > 0, "action should have a positive id");
console.log("✓ proposeAction");

approveAction(db, actionId, "test-owner");
const approvedAction = db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId) as any;
assert.equal(approvedAction.status, "approved");
assert.equal(approvedAction.approved_by, "test-owner");
console.log("✓ approveAction (THE GATE)");

// Test double-approve rejected
assert.throws(() => approveAction(db, actionId), /not pending/);
console.log("✓ Double-approve rejected");

// Test rejectAction
const actionId2 = proposeAction(db, caseId, "SEND_BUYER_MESSAGE", { message: "hello" });
rejectAction(db, actionId2);
assert.equal((db.prepare("SELECT status FROM actions WHERE id = ?").get(actionId2) as any).status, "rejected");
console.log("✓ rejectAction");

// Test evidence & messages
addEvidence(db, caseId, "receipt", "Proof of Charge", true, "SALE-001");
const evidenceList = db.prepare("SELECT * FROM evidence_items WHERE case_id = ?").all(caseId);
assert.equal(evidenceList.length, 1);
console.log("✓ addEvidence");

addMessage(db, caseId, "out", "We are investigating");
const msgList = db.prepare("SELECT * FROM messages WHERE case_id = ?").all(caseId);
assert.equal(msgList.length, 2);
console.log("✓ addMessage");

// ─── Rules layer tests ───

const dupes = findDuplicateCharges(db);
assert.ok(dupes.length > 0, "should find duplicate charges");
assert.equal(dupes[0].amount, 9.99);
console.log("✓ findDuplicateCharges");

const subDup = matchDuplicateForSubscription(db, "I-SUB001");
assert.ok(subDup, "should match duplicate for subscription");
assert.equal(subDup.first_sale_id, "SALE-001");
assert.equal(subDup.second_sale_id, "SALE-002");
console.log("✓ matchDuplicateForSubscription");

// Test CaseQueue and Deadline Flags (Urgent & Overdue)
// Case A: 10 hours remaining -> URGENT
db.prepare("INSERT INTO cases (subscription_id, source, deadline, status) VALUES ('I-SUB001', 'paypal_dispute', ?, 'intake')")
  .run(new Date(Date.now() + 10 * 3600000).toISOString());
// Case B: 2 hours ago -> OVERDUE
db.prepare("INSERT INTO cases (subscription_id, source, deadline, status) VALUES ('I-SUB001', 'paypal_dispute', ?, 'intake')")
  .run(new Date(Date.now() - 2 * 3600000).toISOString());

const queue = caseQueue(db);
assert.ok(queue.length >= 2, "queue should have cases");
const urgentCase = queue.find((c) => c.deadline_status === "urgent");
const overdueCase = queue.find((c) => c.deadline_status === "overdue");
assert.ok(urgentCase, "queue must identify urgent cases (<24h)");
assert.equal(urgentCase.is_urgent, 1);
assert.ok(overdueCase, "queue must identify overdue cases (<0h)");
assert.equal(overdueCase.is_overdue, 1);
console.log("✓ caseQueue (urgent & overdue deadline flags)");

// ─── Portal Token Expiry tests ───

// Valid token
const validToken = generatePortalToken("I-SUB001", 3600); // 1 hour
assert.equal(verifyPortalToken(validToken), "I-SUB001");
console.log("✓ generatePortalToken + verifyPortalToken");

// Expired token (ttl = -10 seconds)
const expiredToken = generatePortalToken("I-SUB001", -10);
assert.equal(verifyPortalToken(expiredToken), null, "expired token must be rejected");
console.log("✓ Expired portal tokens rejected");

assert.equal(verifyPortalToken("bogus:token"), null);
assert.equal(verifyPortalToken("I-SUB001:9999999999:badhmac"), null);
assert.equal(verifyPortalToken(""), null);
console.log("✓ Invalid tokens rejected");

const portalData = getPortalData(db, "I-SUB001");
assert.ok(portalData.subscription, "portal should have subscription");
assert.ok(portalData.transactions.length > 0, "portal should have transactions");
console.log("✓ getPortalData");

// ─── Dunning & Failed Payment tests ───

const failedEvent = {
  id: "WH-FAIL-1",
  event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  resource: { id: "I-SUB001", amount: { total: "9.99", currency: "USD" } },
};
storeEvent(db, failedEvent.id, failedEvent.event_type, JSON.stringify(failedEvent));
await dispatch(db, failedEvent.id, failedEvent.event_type, JSON.stringify(failedEvent));

const failedTx = db.prepare("SELECT * FROM transactions WHERE status = 'failed' AND subscription_id = 'I-SUB001'").get() as any;
assert.ok(failedTx, "failed payment must insert transaction with status='failed'");
const dunningList = dunningCandidates(db);
assert.ok(dunningList.length > 0, "subscription must appear in dunning list");
assert.ok(dunningList[0].failed_count >= 1, "failed_count must be >= 1");
console.log("✓ Dunning / failed payment rule inserts failed transactions & tracks retry count");

// ─── Subscription lifecycle tests ───

const cancelEvent = {
  id: "WH-CANCEL-1",
  event_type: "BILLING.SUBSCRIPTION.CANCELLED",
  resource: { id: "I-SUB001" },
};
storeEvent(db, cancelEvent.id, cancelEvent.event_type, JSON.stringify(cancelEvent));
await dispatch(db, cancelEvent.id, cancelEvent.event_type, JSON.stringify(cancelEvent));
assert.equal((db.prepare("SELECT status FROM subscriptions WHERE paypal_subscription_id = 'I-SUB001'").get() as any).status, "CANCELLED");
console.log("✓ BILLING.SUBSCRIPTION.CANCELLED");

// Regression: CREATED was missed, only UPDATED arrives -> still an active case with a deadline.
const upd = {
  id: "WH-UPD-ONLY",
  event_type: "CUSTOMER.DISPUTE.UPDATED",
  resource: {
    dispute_id: "PP-R-REAL",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    dispute_life_cycle_stage: "CHARGEBACK",
    seller_response_due_date: "2099-01-01T00:00:00.000Z",
    disputed_transactions: [{ seller_transaction_id: "SALE-001" }],
  },
};
storeEvent(db, upd.id, upd.event_type, JSON.stringify(upd));
await dispatch(db, upd.id, upd.event_type, JSON.stringify(upd));
const real = db.prepare("SELECT * FROM cases WHERE paypal_dispute_id = 'PP-R-REAL'").get() as any;
assert.ok(real, "UPDATED alone must create the case");
assert.equal(real.deadline, "2099-01-01T00:00:00.000Z");
assert.notEqual(real.status, "escalated");
assert.ok(caseQueue(db).some((c) => c.id === real.id), "chargeback case must stay in the queue");

console.log("\n═══════════════════════════════════════");
console.log("  All Day 3–4 + Day 4 Gap Tests Passed! ✓");
console.log("═══════════════════════════════════════");
