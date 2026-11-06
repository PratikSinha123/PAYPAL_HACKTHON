// Creates a sandbox product + plan + subscription. The buyer must approve it once in a browser.
// Run: npm run seed [buyer-email]
import { openDb, initDb } from "./db.js";
import { paypal } from "./paypal.js";

const email = process.argv[2] ?? "buyer@example.com";
const db = openDb();
await initDb(db);
type Id = { id: string; links?: { rel: string; href: string }[] };

const product = await paypal<Id>("/v1/catalogs/products", { method: "POST", body: JSON.stringify({ name: "ChargeGuard Demo Plan", type: "SERVICE" }) });
const plan = await paypal<Id>("/v1/billing/plans", {
  method: "POST",
  body: JSON.stringify({
    product_id: product.id, name: "Demo Monthly",
    billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: "9.99", currency_code: "USD" } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
  }),
});
const customId = `cg-${Date.now()}`; // comes back in webhook payloads
const sub = await paypal<Id>("/v1/billing/subscriptions", {
  method: "POST",
  body: JSON.stringify({
    plan_id: plan.id, custom_id: customId, subscriber: { email_address: email },
    application_context: { user_action: "SUBSCRIBE_NOW", return_url: "https://example.com/ok", cancel_url: "https://example.com/cancel" },
  }),
});
await db.execute({
  sql: "INSERT OR REPLACE INTO subscriptions (paypal_subscription_id, customer_email, plan, status, custom_id) VALUES (?,?,?,?,?)",
  args: [sub.id, email, plan.id, "APPROVAL_PENDING", customId],
});
console.log("subscription:", sub.id, "\nbuyer approval link (open, log in as the sandbox PERSONAL account):\n" + sub.links?.find((l) => l.rel === "approve")?.href);
