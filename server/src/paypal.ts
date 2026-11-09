const BASE = () => process.env.PAYPAL_BASE ?? "https://api-m.sandbox.paypal.com";

export type Creds = { id: string; secret: string };
const merchant = (): Creds => ({ id: process.env.PAYPAL_CLIENT_ID!, secret: process.env.PAYPAL_CLIENT_SECRET! });
const tokens = new Map<string, { value: string; exp: number }>(); // one cached token per app

/** Client-credentials token, cached until 60s before expiry. Defaults to the merchant app. */
export async function accessToken(c: Creds = merchant()): Promise<string> {
  const token = tokens.get(c.id);
  if (token && Date.now() < token.exp) return token.value;
  const basic = Buffer.from(`${c.id}:${c.secret}`).toString("base64");
  const r = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`paypal auth ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  tokens.set(c.id, { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

/** Unsigned PayPal-Auth-Assertion header: act on behalf of `payer` (email or payer_id) via app `clientId`. */
export const authAssertion = (clientId: string, payer: string) =>
  [{ alg: "none" }, { iss: clientId, ...(payer.includes("@") ? { email: payer } : { payer_id: payer }) }]
    .map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".") + ".";

export async function paypal<T = unknown>(path: string, init: RequestInit = {}, creds?: Creds): Promise<T> {
  const r = await fetch(`${BASE()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken(creds)}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!r.ok) throw new Error(`paypal ${path} ${r.status}: ${await r.text()}`);
  return (r.status === 204 ? undefined : await r.json()) as T;
}

/** Ask PayPal to verify the webhook signature. Must pass before anything is stored. */
export async function verifyWebhook(headers: Record<string, unknown>, event: unknown): Promise<boolean> {
  const h = (k: string) => String(headers[k] ?? "");
  const r = await paypal<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"), transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: event,
    }),
  });
  return r.verification_status === "SUCCESS";
}

export type DisputeDetail = {
  dispute_id: string;
  dispute_life_cycle_stage?: string;
  dispute_channel?: string;
  dispute_amount?: { currency_code: string; value: string };
  reason?: string;
  status?: string;
  seller_response_due_date?: string;
  disputed_transactions?: Array<{
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    gross_amount?: { currency_code: string; value: string };
  }>;
};

/** Re-fetch authoritative dispute details from PayPal GET /v1/customer/disputes/{id} */
export async function getDispute(disputeId: string): Promise<DisputeDetail> {
  return paypal<DisputeDetail>(`/v1/customer/disputes/${disputeId}`);
}
