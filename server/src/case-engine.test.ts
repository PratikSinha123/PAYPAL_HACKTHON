import assert from "node:assert/strict";
import { openDb, storeEvent } from "./db.js";
import { dispatch } from "./dispatcher.js";
import {
  openCustomerCase, openDisputeCase, advanceCase,
  proposeAction, approveAction, rejectAction,
  getCaseDetail, addEvidence, addMessage,
} from "./case-engine.js";
import { findDuplicateCharges, caseQueue, dunningCandidates, matchDuplicateForSubscription } from "./rules.js";
import { generatePortalToken, verifyPortalToken, getPortalData } from "./portal.js";

const db = openDb(":memory:");

// ─── Dispatcher tests ───

// Test PAYMENT.SALE.COMPLETED
const saleEvent = {
  id: "WH-SALE-1", event_type: "PAYMENT.SALE.COMPLETED",
  resource: {
    id: "SALE-001", billing_agreement_id: "I-SUB001",
    amount: { total: "9.99", currency: "USD" },
    state: "completed", create_time: "2026-11-07T10:00:00Z",
  },
};
storeEvent(db, saleEvent.id, saleEvent.event_type, JSON.stringify(saleEvent));
dispatch(db, saleEvent.id, saleEvent.event_type, JSON.stringify(saleEvent));

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
  id: "WH-ACT-1", event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
  resource: {
    id: "I-SUB001", subscriber: { email_address: "buyer@test.com" },
    plan_id: "P-PLAN001", status: "ACTIVE",
    billing_info: { next_billing_time: "2026-12-07T10:00:00Z" },
    custom_id: "cg-test-001",
  },
};
storeEvent(db, activatedEvent.id, activatedEvent.event_type, JSON.stringify(activatedEvent));
dispatch(db, activatedEvent.id, activatedEvent.event_type, JSON.stringify(activatedEvent));

const subAfter = db.prepare("SELECT * FROM subscriptions WHERE paypal_subscription_id = 'I-SUB001'").get() as any;
assert.equal(subAfter.customer_email, "buyer@test.com");
assert.equal(subAfter.status, "ACTIVE");
console.log("✓ BILLING.SUBSCRIPTION.ACTIVATED dispatched");

// Test second sale for duplicate detection
const saleEvent2 = {
  id: "WH-SALE-2", event_type: "PAYMENT.SALE.COMPLETED",
  resource: {
    id: "SALE-002", billing_agreement_id: "I-SUB001",
    amount: { total: "9.99", currency: "USD" },
    state: "completed", create_time: "2026-11-07T11:00:00Z", // 1 hour later
  },
};
storeEvent(db, saleEvent2.id, saleEvent2.event_type, JSON.stringify(saleEvent2));
dispatch(db, saleEvent2.id, saleEvent2.event_type, JSON.stringify(saleEvent2));
console.log("✓ Second sale stored");

// Test CUSTOMER.DISPUTE.CREATED
const disputeEvent = {
  id: "WH-DISP-1", event_type: "CUSTOMER.DISPUTE.CREATED",
  resource: {
    dispute_id: "PP-D-001",
    disputed_transactions: [{ seller_transaction_id: "SALE-001" }],
    reason: "DUPLICATE_TRANSACTION",
    dispute_life_cycle_stage: "INQUIRY",
  },
};
storeEvent(db, disputeEvent.id, disputeEvent.event_type, JSON.stringify(disputeEvent));
dispatch(db, disputeEvent.id, disputeEvent.event_type, JSON.stringify(disputeEvent));

const disputeCase = db.prepare("SELECT * FROM cases WHERE paypal_dispute_id = 'PP-D-001'").get() as any;
assert.ok(disputeCase, "case should be created for dispute");
assert.equal(disputeCase.source, "paypal_dispute");
assert.equal(disputeCase.reason_code, "DUPLICATE_TRANSACTION");
console.log("✓ CUSTOMER.DISPUTE.CREATED dispatched");

// Test CUSTOMER.DISPUTE.RESOLVED
const resolvedEvent = {
  id: "WH-DISP-R", event_type: "CUSTOMER.DISPUTE.RESOLVED",
  resource: {
    dispute_id: "PP-D-001",
    status: "RESOLVED_SELLER_FAVOUR",
  },
};
storeEvent(db, resolvedEvent.id, resolvedEvent.event_type, JSON.stringify(resolvedEvent));
dispatch(db, resolvedEvent.id, resolvedEvent.event_type, JSON.stringify(resolvedEvent));

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

// Test actions
const actionId = proposeAction(db, caseId, "ISSUE_REFUND", { sale_id: "SALE-002", amount: "9.99" });
assert.ok(actionId > 0);
const actionRow = db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId) as any;
assert.equal(actionRow.status, "pending");
assert.equal(actionRow.proposed_by, "ai");
console.log("✓ proposeAction");

approveAction(db, actionId);
assert.equal((db.prepare("SELECT status FROM actions WHERE id = ?").get(actionId) as any).status, "approved");
console.log("✓ approveAction (THE GATE)");

// Test double-approve
assert.throws(() => approveAction(db, actionId), /not pending/);
console.log("✓ Double-approve rejected");

// Test reject
const actionId2 = proposeAction(db, caseId, "SEND_BUYER_MESSAGE", { message: "test" });
rejectAction(db, actionId2);
assert.equal((db.prepare("SELECT status FROM actions WHERE id = ?").get(actionId2) as any).status, "rejected");
console.log("✓ rejectAction");

// Test evidence
const evidId = addEvidence(db, caseId, "transaction_record", "Payment receipt", true, "SALE-001");
assert.ok(evidId > 0);
console.log("✓ addEvidence");

// Test messages
addMessage(db, caseId, "out", "We found a duplicate charge and will process a refund.");
const msgs = db.prepare("SELECT * FROM messages WHERE case_id = ?").all(caseId);
assert.equal(msgs.length, 2); // 1 from openCustomerCase + 1 from addMessage
console.log("✓ addMessage");

// ─── Rules tests ───

const dupes = findDuplicateCharges(db);
assert.ok(dupes.length > 0, "should find duplicate charges");
assert.equal(dupes[0].amount, 9.99);
console.log("✓ findDuplicateCharges");

const dupMatch = matchDuplicateForSubscription(db, "I-SUB001");
assert.ok(dupMatch, "should match duplicate for subscription");
console.log("✓ matchDuplicateForSubscription");

const queue = caseQueue(db);
assert.ok(queue.length > 0, "case queue should not be empty");
console.log("✓ caseQueue");

// ─── Portal token tests ───

const token = generatePortalToken("I-SUB001");
assert.ok(token.startsWith("I-SUB001:"), "token should contain subscription id");
const verified = verifyPortalToken(token);
assert.equal(verified, "I-SUB001");
console.log("✓ generatePortalToken + verifyPortalToken");

assert.equal(verifyPortalToken("bogus:token"), null);
assert.equal(verifyPortalToken(""), null);
console.log("✓ Invalid tokens rejected");

const portalData = getPortalData(db, "I-SUB001");
assert.ok(portalData.subscription, "portal should have subscription");
assert.ok(portalData.transactions.length > 0, "portal should have transactions");
console.log("✓ getPortalData");

// ─── Subscription lifecycle tests ───

const cancelEvent = {
  id: "WH-CANCEL-1", event_type: "BILLING.SUBSCRIPTION.CANCELLED",
  resource: { id: "I-SUB001" },
};
storeEvent(db, cancelEvent.id, cancelEvent.event_type, JSON.stringify(cancelEvent));
dispatch(db, cancelEvent.id, cancelEvent.event_type, JSON.stringify(cancelEvent));
assert.equal((db.prepare("SELECT status FROM subscriptions WHERE paypal_subscription_id = 'I-SUB001'").get() as any).status, "CANCELLED");
console.log("✓ BILLING.SUBSCRIPTION.CANCELLED");

console.log("\n═══════════════════════════════════════");
console.log("  All Day 3–4 tests passed! ✓");
console.log("═══════════════════════════════════════");
