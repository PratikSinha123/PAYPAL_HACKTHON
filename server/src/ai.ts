import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const RETRYABLE_STATUS = new Set([429, 503]);
const DELAYS_MS = [1000, 2000, 4000];
const ATTEMPT_TIMEOUT_MS = 15_000; // 15s per attempt

/** Fetch with a manual abort timeout that is cleanly cancelled on success/failure. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("attempt timed out after 15s")), ATTEMPT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Fallback schema-compliant generator for testing, offline demos, or when live AI endpoint is unreachable. */
function generateFallbackJson<T extends z.ZodType>(schema: T, system: string, user: string): z.infer<T> {
  const shape = (schema as any).shape ?? {};
  const lowerUser = user.toLowerCase();
  const lowerSystem = system.toLowerCase();

  // 1. Job 3: Drafting & Recommendation (has 'recommended_action')
  if ("recommended_action" in shape) {
    let type = "SEND_BUYER_MESSAGE";
    let payload: Record<string, any> = {};
    let reasoning = "Proposing customer resolution.";
    let buyer_message = "Hello, thank you for reaching out. We are reviewing your account and will resolve this immediately.";
    let dispute_evidence_text: string | null = null;

    const isDispute = lowerUser.includes("isdispute: true") || lowerUser.includes("source: paypal_dispute");

    const saleMatch = user.match(/Target Sale ID:\s*([^\s\n]+)/i);
    const saleId = saleMatch ? saleMatch[1] : "SALE-1";
    const amountMatch = user.match(/Amount:\s*\$?([0-9.]+)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 9.99;

    if (isDispute) {
      dispute_evidence_text = `Merchant representment: verified system records confirm transaction ${saleId} and service provisioning under agreed terms.`;
    }

    const toneMatch = user.match(/Merchant Tone:\s*([^\s\n]+)/i);
    const tone = toneMatch ? toneMatch[1] : "empathetic_professional";

    if (isDispute && !lowerUser.includes("duplicate")) {
      type = "PROVIDE_EVIDENCE";
      payload = { note: "Access logs and transaction history attached.", dispute_evidence_text, evidence_type: "OTHER" };
      reasoning = "Merchant records verify valid subscription access provided.";
      buyer_message = "We have submitted documentation to PayPal confirming your active subscription service.";
    } else if (lowerUser.includes("duplicate")) {
      type = "ISSUE_REFUND";
      payload = { sale_id: saleId, amount, note: "Duplicate billing refund" };
      reasoning = "Pure SQL rule identified twin charges. Automatic refund recommended.";
      if (tone === "firm_formal") {
        buyer_message = `Our system confirmed two renewal charges on your account. A refund of $${amount} has been submitted for transaction ${saleId}.`;
      } else if (tone === "conciliatory") {
        buyer_message = `We are so sorry for the double charge of $${amount}! We have initiated an immediate full refund for transaction ${saleId}.`;
      } else if (tone === "friendly") {
        buyer_message = `Hey! Good catch on the double charge of $${amount}. We've initiated a full refund for transaction ${saleId}!`;
      } else {
        buyer_message = `Hello, we noticed the duplicate $${amount} charge on your account and have initiated a full refund for transaction ${saleId}.`;
      }
    } else if (lowerUser.includes("subscription_cancel")) {
      type = "CANCEL_SUBSCRIPTION";
      payload = { reason: "Customer requested cancellation" };
      reasoning = "Customer requested cancellation through portal.";
      buyer_message = "Hello, we have processed your subscription cancellation as requested. No further renewals will occur.";
    } else {
      type = "SEND_BUYER_MESSAGE";
      payload = { message: buyer_message };
      reasoning = "Engaging customer directly to resolve inquiry and deflect dispute.";
    }

    const mock: any = {
      buyer_message,
      dispute_evidence_text,
      recommended_action: {
        type,
        payload,
        reasoning,
      },
    };
    return schema.parse(mock);
  }

  // 2. Job 2: Evidence Assessment (has 'strength')
  if ("strength" in shape) {
    let present: string[] = [];
    let missing: string[] = [];

    if (user.includes("Available Evidence Items in System:")) {
      try {
        const jsonPart = user.split("Available Evidence Items in System:")[1]?.trim();
        const items = JSON.parse(jsonPart);
        for (const it of items) {
          if (it.present) present.push(it.label || "Record");
          else missing.push(it.label || "Record");
        }
      } catch {}
    }

    if (present.length === 0) {
      present = ["Subscription billing agreement", "Transaction payment log"];
      missing = ["Customer direct acknowledgement"];
    }

    const total = present.length + missing.length;
    const strength = `${present.length} of ${total}`;

    const mock: any = {
      present,
      missing,
      strength,
      rationale: `${present.length} of ${total} required evidence records confirmed in merchant ledger.`,
    };
    return schema.parse(mock);
  }

  // 3. Job 1: Triage (has 'reason_code')
  if ("reason_code" in shape || lowerSystem.includes("triage") || lowerSystem.includes("classify")) {
    let reason_code = "INR";
    let remedy_sought = "EXPLANATION";
    let urgency = "MEDIUM";

    if (
      lowerUser.includes("duplicate") ||
      lowerUser.includes("twice") ||
      lowerUser.includes("two ") ||
      lowerUser.includes("charged twice")
    ) {
      reason_code = "DUPLICATE";
      remedy_sought = "REFUND";
      urgency = "HIGH";
    } else if (
      lowerUser.includes("cancel") ||
      lowerUser.includes("unsubscribe") ||
      lowerUser.includes("stop")
    ) {
      reason_code = "SUBSCRIPTION_CANCEL";
      remedy_sought = "CANCEL_SUBSCRIPTION";
      urgency = "HIGH";
    } else if (
      lowerUser.includes("unauthorized") ||
      lowerUser.includes("fraud") ||
      lowerUser.includes("didn't authorize") ||
      lowerUser.includes("unrecognised")
    ) {
      reason_code = "UNAUTHORIZED";
      remedy_sought = "REFUND";
      urgency = "CRITICAL";
    } else if (
      lowerUser.includes("broken") ||
      lowerUser.includes("different") ||
      lowerUser.includes("not as described") ||
      lowerUser.includes("snad")
    ) {
      reason_code = "SNAD";
      remedy_sought = "REFUND";
      urgency = "MEDIUM";
    }

    const saleMatch = user.match(/SALE-[A-Z0-9-]+/i) || user.match(/tx[a-z0-9_-]+/i);
    const transaction_ref = saleMatch ? saleMatch[0] : null;

    const mock: any = {
      reason_code,
      transaction_ref,
      remedy_sought,
      urgency,
      summary: `Customer reports ${reason_code.toLowerCase()} issue requesting ${remedy_sought.toLowerCase()}.`,
    };
    return schema.parse(mock);
  }

  throw new Error("Unable to generate schema response from fallback generator");
}

/** Marks a result that came from the keyword-rules fallback instead of a live model (non-enumerable, so equality checks ignore it). */
const FALLBACK = Symbol("chargeguard.fallback");
export const isFallback = (v: unknown): boolean => Boolean((v as any)?.[FALLBACK]);

/** The fallback is never silent: it logs why, and the result is marked so the UI can say so. */
function fallbackWithNotice<T extends z.ZodType>(schema: T, system: string, user: string, why: string): z.infer<T> {
  console.warn(`[ai] NOT using a live model (${why}); using the deterministic rules fallback`);
  const out = generateFallbackJson(schema, system, user);
  Object.defineProperty(out, FALLBACK, { value: true });
  return out;
}

/** One call for all three AI jobs: prompt in, zod-validated JSON out. Never free prose. */
export async function generateJson<T extends z.ZodType>(
  schema: T,
  system: string,
  user: string,
  retries = 1
): Promise<z.infer<T>> {
  const apiKey = process.env.AI_API_KEY?.trim();
  const isMock = process.env.AI_MOCK === "true" || !apiKey || apiKey === "change-me";

  if (isMock) {
    return fallbackWithNotice(schema, system, user, process.env.AI_MOCK === "true" ? "AI_MOCK=true" : "no AI_API_KEY set");
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let r: Response | undefined;
    try {
      r = await fetchWithTimeout(`${process.env.AI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL ?? "gemini-1.5-flash",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${system}\nReply with valid JSON only, strictly matching this JSON Schema:\n${JSON.stringify(
                zodToJsonSchema(schema)
              )}`,
            },
            { role: "user", content: user },
          ],
        }),
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const delay = DELAYS_MS[attempt] ?? 1000;
        console.warn(`ai fetch failed (${lastError.message}), retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
      }
      continue;
    }

    if (r.ok) {
      const j = (await r.json()) as { choices: { message: { content: string } }[] };
      const raw = j.choices[0]?.message?.content?.trim() ?? "{}";
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
      return schema.parse(JSON.parse(cleaned));
    }

    if (!RETRYABLE_STATUS.has(r.status)) {
      return fallbackWithNotice(schema, system, user, `provider returned HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    }

    lastError = new Error(`ai ${r.status}: ${await r.text()}`);
    if (attempt < retries) {
      const delay = DELAYS_MS[attempt] ?? 1000;
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  return fallbackWithNotice(schema, system, user, `request failed: ${lastError?.message}`);
}
