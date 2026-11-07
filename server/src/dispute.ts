// Sandbox dispute driver for the demo.
//   npm run dispute create <sale_id> [reason]   buyer opens a dispute (needs BUYER_* env)
//   npm run dispute settle <dispute_id>         force the outcome in the merchant's favour
// ponytail: payloads follow PayPal's docs but are untested against the sandbox; reason/status helpers not added yet.
import { authAssertion, paypal } from "./paypal.js";

const [cmd, id, reason = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"] = process.argv.slice(2);
const buyer = { id: process.env.BUYER_CLIENT_ID!, secret: process.env.BUYER_CLIENT_SECRET! };

if (cmd === "create" && id) {
  const r = await paypal<{ dispute_id: string }>("/v1/customer/disputes", {
    method: "POST",
    headers: { "PayPal-Auth-Assertion": authAssertion(buyer.id, process.env.BUYER_EMAIL!) },
    body: JSON.stringify({ disputed_transactions: [{ seller_transaction_id: id }], reason,
      dispute_life_cycle_stage: "INQUIRY", dispute_channel: "INTERNAL" }),
  }, buyer);
  console.log("dispute:", r.dispute_id);
} else if (cmd === "settle" && id) {
  await paypal(`/v1/customer/disputes/${id}/adjudicate`, { method: "POST", body: JSON.stringify({ adjudication_outcome: "SELLER_FAVOUR" }) });
  console.log("settled in merchant favour");
} else console.log("usage: npm run dispute create <sale_id> [reason] | settle <dispute_id>");
