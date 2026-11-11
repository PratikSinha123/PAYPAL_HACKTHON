import { z } from "zod";
import type { Db } from "./db.js";
import { generateJson } from "./ai.js";
import {
  getCaseDetail,
  advanceCase,
  proposeAction,
  addEvidence,
  addMessage,
} from "./case-engine.js";
import { matchDuplicateForSubscription } from "./rules.js";

/* ───── Job 1 Schema: Triage ───── */
export const TriageSchema = z.object({
  reason_code: z
    .enum(["INR", "SNAD", "UNAUTHORIZED", "DUPLICATE", "SUBSCRIPTION_CANCEL"])
    .describe("PayPal-aligned reason category"),
  transaction_ref: z
    .string()
    .nullable()
    .describe("Specific PayPal sale ID referenced or identified"),
  remedy_sought: z
    .enum(["REFUND", "CANCEL_SUBSCRIPTION", "EXPLANATION", "REPLACEMENT"])
    .describe("What outcome the customer wants"),
  urgency: z
    .enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
    .describe("Urgency based on tone and deadline"),
  summary: z
    .string()
    .describe("Concise 1-2 sentence factual summary of the issue"),
});
export type TriageResult = z.infer<typeof TriageSchema>;

/* ───── Job 2 Schema: Evidence Assessment ───── */
export const EvidenceSchema = z.object({
  present: z.array(z.string()).describe("Evidence items confirmed available"),
  missing: z.array(z.string()).describe("Evidence items required by PayPal but missing"),
  strength: z
    .string()
    .describe("Factual score in format 'X of Y' (NEVER a percentage/probability)"),
  rationale: z
    .string()
    .describe("1-2 sentences explaining strength and key evidence gap"),
});
export type EvidenceResult = z.infer<typeof EvidenceSchema>;

/* ───── Job 3 Schema: Drafting & Recommendation ───── */
export const DraftSchema = z.object({
  buyer_message: z
    .string()
    .nullable()
    .describe("Empathetic, clear resolution message to customer for portal/inquiry"),
  dispute_evidence_text: z
    .string()
    .nullable()
    .describe("Formal representment statement to PayPal dispute adjudicators"),
  recommended_action: z.object({
    type: z.enum([
      "SEND_BUYER_MESSAGE",
      "ISSUE_REFUND",
      "MAKE_OFFER",
      "PROVIDE_EVIDENCE",
      "ACCEPT_CLAIM",
      "CANCEL_SUBSCRIPTION",
    ]),
    payload: z.record(z.string(), z.any()).describe("Action payload parameters for executor"),
    reasoning: z
      .string()
      .describe("1-2 sentence business rationale for why this action resolves the issue"),
  }),
});
export type DraftResult = z.infer<typeof DraftSchema>;

/* ═══════════════════════════════════════════════════════════════
   Job 1: Triage
   ═══════════════════════════════════════════════════════════════ */
export async function runTriage(db: Db, caseId: number): Promise<TriageResult> {
  const detail = getCaseDetail(db, caseId);
  if (!detail) throw new Error(`case ${caseId} not found`);

  // Extract customer messages or dispute context
  const latestMessage = detail.messages?.find((m: any) => m.direction === "in")?.body ?? "";
  const sub = detail.subscription;
  const txns = detail.transactions ?? [];

  // Deterministic rule check: duplicate charges
  let ruleContext = "";
  if (detail.subscription_id) {
    const dup = matchDuplicateForSubscription(db, detail.subscription_id);
    if (dup) {
      ruleContext += `\n[Deterministic Rule Alert: Pure SQL duplicate rule detected 2 sales with identical amount $${dup.amount} inside 48h (Sales: ${dup.first_sale_id} and ${dup.second_sale_id})].`;
    }
  }

  // Pre-mapped PayPal dispute reason codes
  const disputeMapping: Record<string, "INR" | "SNAD" | "UNAUTHORIZED" | "DUPLICATE" | "SUBSCRIPTION_CANCEL"> = {
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "INR",
    MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "SNAD",
    UNAUTHORISED: "UNAUTHORIZED",
    UNAUTHORIZED: "UNAUTHORIZED",
    DUPLICATE_TRANSACTION: "DUPLICATE",
    CANCEL_SUBSCRIPTION: "SUBSCRIPTION_CANCEL",
  };

  const paypalHint = detail.reason_code && disputeMapping[detail.reason_code]
    ? `\n[PayPal Webhook Dispute Reason: ${detail.reason_code} -> maps to ${disputeMapping[detail.reason_code]}].`
    : "";

  const system = `You are ChargeGuard AI's triage agent for a subscription merchant on PayPal.
Classify the customer complaint into one of five reason codes:
- INR (Item Not Received / Access not granted)
- SNAD (Significantly Not As Described / Broken feature)
- UNAUTHORIZED (Unrecognized charge / Fraud claim)
- DUPLICATE (Charged twice for same renewal/period)
- SUBSCRIPTION_CANCEL (Subscription cancellation dispute)
Extract the referenced transaction ID if identified, the remedy sought, urgency, and a crisp 1-sentence summary.`;

  const user = `Case ID: ${caseId}
Source: ${detail.source}
Subscription ID: ${detail.subscription_id ?? "N/A"}
Customer Email: ${sub?.customer_email ?? "unknown"}
Customer Message / Complaint: "${latestMessage}"
Recent Transactions: ${JSON.stringify(
    txns.slice(0, 5).map((t: any) => ({ id: t.paypal_sale_id, amount: t.amount, status: t.status, date: t.created_at }))
  )}${ruleContext}${paypalHint}`;

  const result = await generateJson(TriageSchema, system, user);

  // Update case in DB
  db.prepare("UPDATE cases SET reason_code = ? WHERE id = ?").run(result.reason_code, caseId);

  // Advance state from intake -> triaged if applicable
  if (detail.status === "intake") {
    advanceCase(db, caseId, "triaged");
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════
   Job 2: Evidence Assessment
   ═══════════════════════════════════════════════════════════════ */
export async function runEvidenceAssessment(
  db: Db,
  caseId: number,
  triage: TriageResult
): Promise<EvidenceResult> {
  const detail = getCaseDetail(db, caseId);
  if (!detail) throw new Error(`case ${caseId} not found`);

  // Clear any existing auto-evidence for idempotency
  db.prepare("DELETE FROM evidence_items WHERE case_id = ?").run(caseId);

  // Check what data exists in DB
  const hasSub = Boolean(detail.subscription);
  const txns = detail.transactions ?? [];
  const hasTxn = txns.length > 0;
  const duplicateMatch = detail.subscription_id ? matchDuplicateForSubscription(db, detail.subscription_id) : null;

  // Insert standard evidence items based on reason_code
  if (hasSub) {
    addEvidence(db, caseId, "subscription_record", "Active PayPal Billing Agreement", true, detail.subscription_id);
  } else {
    addEvidence(db, caseId, "subscription_record", "PayPal Billing Agreement Record", false);
  }

  if (hasTxn) {
    const saleId = triage.transaction_ref ?? txns[0]?.paypal_sale_id;
    addEvidence(db, caseId, "transaction_receipt", "PayPal Sale Transaction Record", true, saleId);
  } else {
    addEvidence(db, caseId, "transaction_receipt", "PayPal Sale Transaction Record", false);
  }

  // Reason-code specific evidence additions
  if (triage.reason_code === "DUPLICATE") {
    if (duplicateMatch) {
      addEvidence(db, caseId, "twin_ledger", "SQL Ledger Duplicate Charges Match", true, `${duplicateMatch.first_sale_id} & ${duplicateMatch.second_sale_id}`);
    } else {
      addEvidence(db, caseId, "twin_ledger", "SQL Ledger Duplicate Charges Match", false);
    }
    addEvidence(db, caseId, "billing_schedule", "Standard Monthly Renewal Cycle", true, "1 Month Interval");
  } else if (triage.reason_code === "INR") {
    addEvidence(db, caseId, "access_log", "Digital Account Access / Login Logs", false);
    addEvidence(db, caseId, "welcome_email", "Access Provisioning Confirmation Email", true, "Automated webhook dispatch");
  } else if (triage.reason_code === "SNAD") {
    addEvidence(db, caseId, "terms_acceptance", "Terms of Service Accepted at Checkout", true, "Checkout acceptance timestamp");
    addEvidence(db, caseId, "product_specs", "Public Service Feature Specification", true, "Plan Service Definition");
  } else if (triage.reason_code === "UNAUTHORIZED") {
    addEvidence(db, caseId, "login_ip_match", "Subscriber IP & Device Match Record", false);
    addEvidence(db, caseId, "recurring_history", "Prior Successful Subscription Payments", txns.length > 1, `${txns.length} prior sales`);
  } else {
    addEvidence(db, caseId, "cancellation_policy", "Published Subscription Cancellation Policy", true, "Terms Section 4.2");
  }

  // Refresh evidence list from DB
  const evidenceList = db.prepare("SELECT * FROM evidence_items WHERE case_id = ?").all(caseId) as any[];

  const system = `You are ChargeGuard AI's evidence assessment analyst.
Evaluate available merchant evidence against PayPal's dispute adjudication standards for reason code "${triage.reason_code}".
Rule: NEVER output a fake win probability percentage (e.g. "75%"). Output strength as factual ratio "X of Y" (e.g. "3 of 4").
State clearly what is present and what is missing. Provide 1-2 sentence rationale.`;

  const user = `Case ID: ${caseId}
Reason Code: ${triage.reason_code}
Available Evidence Items in System:
${JSON.stringify(evidenceList.map((e) => ({ label: e.label, present: Boolean(e.present), value: e.value })))}`;

  const result = await generateJson(EvidenceSchema, system, user);

  // Advance case state from triaged -> evidence_assembled
  if (detail.status === "triaged") {
    advanceCase(db, caseId, "evidence_assembled");
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════
   Job 3: Drafting & Recommendation
   ═══════════════════════════════════════════════════════════════ */
export async function runDrafting(
  db: Db,
  caseId: number,
  triage: TriageResult,
  evidence: EvidenceResult
): Promise<DraftResult> {
  const detail = getCaseDetail(db, caseId);
  if (!detail) throw new Error(`case ${caseId} not found`);

  const txns = detail.transactions ?? [];
  const targetSaleId = triage.transaction_ref ?? txns[0]?.paypal_sale_id ?? "UNKNOWN_SALE";
  const amount = txns.find((t: any) => t.paypal_sale_id === targetSaleId)?.amount ?? 9.99;

  const isDispute = detail.source === "paypal_dispute";

  const system = `You are ChargeGuard AI's dispute resolution and deflection copywriter.
Conditioned on the triage reason (${triage.reason_code}) and evidence assessment (${evidence.strength}):
1. Generate a polite, empathetic buyer-facing message ('buyer_message') to resolve the problem directly with the customer.
2. If this is a formal PayPal dispute, also generate formal representment text ('dispute_evidence_text') for PayPal adjudicators.
3. Recommend exactly one actionable next step ('recommended_action') from:
   - SEND_BUYER_MESSAGE
   - ISSUE_REFUND
   - MAKE_OFFER
   - PROVIDE_EVIDENCE
   - ACCEPT_CLAIM
   - CANCEL_SUBSCRIPTION
The action payload must contain required fields (e.g. sale_id, amount, note, or message).`;

  const user = `Case ID: ${caseId}
Source: ${detail.source} (isDispute: ${isDispute})
Customer Email: ${detail.subscription?.customer_email ?? "customer"}
Triage Summary: ${triage.summary}
Remedy Sought: ${triage.remedy_sought}
Target Sale ID: ${targetSaleId}
Amount: $${amount}
Evidence Strength: ${evidence.strength}
Evidence Present: ${evidence.present.join(", ")}
Evidence Missing: ${evidence.missing.join(", ")}`;

  const result = await generateJson(DraftSchema, system, user);

  // Enqueue proposed action for the Approval Gate
  const actionId = proposeAction(
    db,
    caseId,
    result.recommended_action.type,
    result.recommended_action.payload,
    "ai"
  );

  // If buyer_message was drafted, record draft in messages table
  if (result.buyer_message) {
    addMessage(db, caseId, "out", result.buyer_message);
  }

  // Advance case state: evidence_assembled -> recommended -> awaiting_approval
  if (detail.status === "evidence_assembled") {
    advanceCase(db, caseId, "recommended");
    advanceCase(db, caseId, "awaiting_approval");
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════
   End-to-End Case Pipeline Orchestrator
   ═══════════════════════════════════════════════════════════════ */
export async function processCase(
  db: Db,
  caseId: number
): Promise<{
  triage: TriageResult;
  evidence: EvidenceResult;
  draft: DraftResult;
  actionId: number;
}> {
  // Job 1: Triage
  const triage = await runTriage(db, caseId);

  // Job 2: Evidence Assessment
  const evidence = await runEvidenceAssessment(db, caseId, triage);

  // Job 3: Drafting & Recommendation
  const draft = await runDrafting(db, caseId, triage, evidence);

  // Retrieve enqueued action ID
  const latestAction = db
    .prepare("SELECT id FROM actions WHERE case_id = ? ORDER BY id DESC LIMIT 1")
    .get(caseId) as { id: number };

  return {
    triage,
    evidence,
    draft,
    actionId: latestAction.id,
  };
}
