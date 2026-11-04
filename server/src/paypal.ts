const BASE = () => process.env.PAYPAL_BASE ?? "https://api-m.sandbox.paypal.com";

let token: { value: string; exp: number } | undefined;

/** Client-credentials token, cached until 60s before expiry. */
export async function accessToken(): Promise<string> {
  if (token && Date.now() < token.exp) return token.value;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`paypal auth ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return token.value;
}

export async function paypal<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...init.headers },
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
