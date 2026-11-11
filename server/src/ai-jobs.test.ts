import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
import assert from "node:assert/strict";
import { openDb } from "./db.js";
import {
  openCustomerCase,
  getCaseDetail,
  approveAction,
} from "./case-engine.js";
import {
  TriageSchema,
  EvidenceSchema,
  DraftSchema,
  processCase,
} from "./ai-jobs.js";

const db = openDb(":memory:");

console.log("Starting Days 5–6 AI Layer Tests...\n");

// Setup test subscription & twin transactions for duplicate detection
db.prepare(
  "INSERT INTO subscriptions (paypal_subscription_id, customer_email, plan, status) VALUES ('I-TEST-AI', 'sarah@example.com', 'P-MONTHLY', 'ACTIVE')"
).run();

db.prepare(
  "INSERT INTO transactions (paypal_sale_id, subscription_id, amount, currency, status, created_at) VALUES ('SALE-AI-1', 'I-TEST-AI', 9.99, 'USD', 'completed', '2026-11-08T10:00:00Z')"
).run();

db.prepare(
  "INSERT INTO transactions (paypal_sale_id, subscription_id, amount, currency, status, created_at) VALUES ('SALE-AI-2', 'I-TEST-AI', 9.99, 'USD', 'completed', '2026-11-08T10:45:00Z')"
).run();

// 1. Test Schema validations with mock data
const mockTriage = {
  reason_code: "DUPLICATE",
  transaction_ref: "SALE-AI-2",
  remedy_sought: "REFUND",
  urgency: "HIGH",
  summary: "Customer was charged twice in under an hour for monthly subscription.",
};
const parsedTriage = TriageSchema.parse(mockTriage);
assert.equal(parsedTriage.reason_code, "DUPLICATE");
console.log("✓ Job 1 TriageSchema validation passed");

const mockEvidence = {
  present: ["PayPal Sale Transaction Record", "SQL Ledger Duplicate Charges Match"],
  missing: ["Customer explicit confirmation"],
  strength: "2 of 3",
  rationale: "Both transactions recorded in ledger with identical amounts 45 minutes apart.",
};
const parsedEvidence = EvidenceSchema.parse(mockEvidence);
assert.equal(parsedEvidence.strength, "2 of 3");
assert.ok(!parsedEvidence.strength.includes("%"), "Strength must never be a percentage!");
console.log("✓ Job 2 EvidenceSchema validation passed (factual score, no win probability)");

const mockDraft = {
  buyer_message: "Hello Sarah, we noticed the duplicate $9.99 charge and have initiated a full refund for transaction SALE-AI-2.",
  dispute_evidence_text: null,
  recommended_action: {
    type: "ISSUE_REFUND" as const,
    payload: { sale_id: "SALE-AI-2", amount: 9.99, note: "Duplicate billing refund" },
    reasoning: "Deterministic SQL ledger confirmed twin charges within 45 minutes.",
  },
};
const parsedDraft = DraftSchema.parse(mockDraft);
assert.equal(parsedDraft.recommended_action.type, "ISSUE_REFUND");
console.log("✓ Job 3 DraftSchema validation passed");

// 2. Test End-to-End processCase with live or fallback AI model
console.log("\nRunning AI pipeline (Jobs 1, 2, 3) on customer duplicate complaint...");
const caseId = openCustomerCase(
  db,
  "I-TEST-AI",
  "Hi, I noticed two $9.99 charges on my card today for my monthly plan. Could you please check and refund one?"
);

assert.equal(getCaseDetail(db, caseId)?.status, "intake");
console.log(`✓ Case ${caseId} created in 'intake' state`);

const result = await processCase(db, caseId);

console.log("AI Triage Output:", result.triage);
console.log("AI Evidence Assessment:", result.evidence);
console.log("AI Proposed Action:", result.draft.recommended_action);

// Verify state transitions
const afterDetail = getCaseDetail(db, caseId);
assert.equal(afterDetail?.status, "awaiting_approval", "Case must stop at 'awaiting_approval' gate");
assert.equal(afterDetail?.reason_code, "DUPLICATE", "AI should correctly classify as DUPLICATE");
assert.ok(result.evidence.strength.includes("of"), "Evidence strength should be 'X of Y'");
assert.ok(result.actionId > 0, "Action must be enqueued");

// Verify that the action is strictly pending at the Approval Gate
const actionRow = db.prepare("SELECT * FROM actions WHERE id = ?").get(result.actionId) as any;
assert.equal(actionRow.status, "pending", "Action must be pending approval");
assert.equal(actionRow.proposed_by, "ai");
console.log("✓ Case halted at 'awaiting_approval' gate; action enqueued as 'pending'");

// Verify owner approval gate transition
approveAction(db, result.actionId, "merchant-owner");
const approvedAction = db.prepare("SELECT * FROM actions WHERE id = ?").get(result.actionId) as any;
assert.equal(approvedAction.status, "approved");
assert.equal(approvedAction.approved_by, "merchant-owner");
console.log("✓ Owner approved action via Approval Gate");

console.log("\n═══════════════════════════════════════");
console.log("  All Days 5–6 AI Tests Passed! ✓");
console.log("═══════════════════════════════════════");
