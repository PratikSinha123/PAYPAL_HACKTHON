# ChargeGuard AI — Technical Specification

**Project:** ChargeGuard AI  
**Event:** PayPal AI Hackathon 2026  
**Submission deadline:** 12 Nov 2026, 12:00 PT (13 Nov, 01:30 IST)  
**Status:** Draft v1

---

## 0. Read this first

If you are joining the team, read sections 1, 2 and 5. That is enough to start
work. Everything after section 5 is reference.

The single most important design decision in this project: **the AI never
touches money.** It proposes; a human approves; only then do we call PayPal.
If you are about to write code that calls a PayPal write endpoint directly
from an AI code path, stop and read section 5.6.

---

## 1. What we are building, in plain English

A small business sells subscriptions through PayPal. Three things go wrong
constantly and they have no staff to deal with any of them:

1. A renewal payment fails and nobody notices until the customer leaves.
2. A customer gets charged twice and emails angrily into a void.
3. A customer opens a PayPal dispute, and the business has a short window to
   respond with evidence or automatically lose the money.

ChargeGuard gives that business two things:

- **A customer portal.** The customer describes the problem in plain words.
  No forms, no category dropdowns, no ticket numbers.
- **An owner dashboard.** Every problem becomes a *case*. AI reads it, works
  out what kind of problem it is, checks what evidence exists, writes a draft
  reply, and recommends an action. The owner clicks approve. ChargeGuard
  executes it against PayPal.

The point is not to win disputes. The point is to **resolve the problem before
it becomes a dispute at all.** A dispute you win still costs fees and hours. A
dispute that never opens costs nothing.

---

## 2. Glossary

Read this before the architecture. Half the confusion on a payments project is
vocabulary.

### 2.1 Payments domain

| Term | Definition |
|---|---|
| **Dispute** | A customer formally telling PayPal that something was wrong with a transaction. Starts a clock. |
| **Inquiry** | The first, informal stage of a dispute. The merchant and buyer can still message each other. **This is the stage we care most about** — it can be resolved without PayPal deciding anything. |
| **Claim** | An escalated dispute. PayPal now adjudicates and the merchant must submit evidence. |
| **Chargeback** | The customer went to their card issuer instead of PayPal. More expensive, harder to fight, longer timeline. |
| **Reason code** | PayPal's category for why a dispute was opened. Determines what evidence is required. |
| **INR** | "Item Not Received." Customer says they paid and got nothing. Beaten with proof of delivery or access. |
| **SNAD** | "Significantly Not As Described." Customer says they got something different from what was advertised. Beaten with the product description, screenshots, and terms. |
| **UNAUTHORIZED** | Customer says they never made the purchase. Beaten with login records, IP, device history. |
| **Evidence** | Files and text the merchant submits to PayPal to support their side of a dispute. |
| **Seller response due date** | The deadline by which the merchant must respond. Miss it and the case is lost by default. |
| **Dunning** | The retry-and-chase process after a recurring payment fails. |
| **Deflection** | Resolving a customer's complaint before they open a dispute. Our core value. |
| **Representment** | The industry term for contesting a chargeback with evidence. |

### 2.2 PayPal platform

| Term | Definition |
|---|---|
| **Sandbox** | PayPal's fake-money test environment. Mirrors the live API. Everything we build runs here. |
| **Business / personal sandbox account** | Test accounts. Business = the merchant (our user). Personal = the customer. Disputes are created *by* the personal account and handled *by* the business account. |
| **REST app** | A credential pair (Client ID + Secret) created in the Developer Dashboard, scoped to one sandbox business account. |
| **Client credentials grant** | The OAuth flow we use. POST client ID + secret, get a bearer token valid for several hours. |
| **Webhook** | An HTTP POST PayPal sends us when something happens. Our primary source of truth. |
| **Webhook simulator** | A Developer Dashboard tool that fires any event type on demand. Essential, because we cannot wait a month for a real renewal. |
| **Subscription** | A recurring billing arrangement. PayPal calls the underlying object a *billing agreement*. |
| **Billing plan** | The template a subscription is created from — amount, currency, frequency. |
| **Sale vs capture** | Two different payment object types. **Subscriptions produce `sale` objects.** Orders v2 checkouts produce `capture` objects. This matters for webhook names — see 6.2. |

### 2.3 Our own terms

| Term | Definition |
|---|---|
| **Case** | The central object. One customer problem, from first report to resolution. Everything in this system is a case. |
| **Case source** | How the case started: `customer` (portal complaint) or `paypal_dispute` (webhook). |
| **Action** | A proposed change to the world — send a message, issue a refund, submit evidence. Rows in a table, not function calls. |
| **Approval gate** | The rule that no action executes until a human sets its status to `approved`. |
| **Evidence item** | A single piece of supporting material attached to a case. |
| **Evidence strength** | Our honest replacement for a win probability. See 5.5. |
| **Seeder** | A separate script that creates test subscriptions, transactions and disputes in sandbox so the demo is reproducible. |

---

## 3. Why this wins points

The hackathon judges on five equally weighted criteria: technological
implementation, design, potential impact, innovation, and presentation.
Projects must meaningfully use the PayPal developer platform in the free
sandbox plus an AI tool or model, and must be a working prototype — a mockup
does not qualify.

Where we score:

- **Technological implementation.** Four PayPal surfaces (Subscriptions,
  Transactions, Disputes, webhooks), real webhook signature verification, a
  real state machine. Most entries will be a checkout button plus a chatbot.
- **Potential impact.** Every small merchant taking recurring payments has
  this problem and no tooling for it.
- **Innovation.** The deflection framing. Commercial dispute tools are
  merchant-only and post-dispute. A two-sided system that intercepts the
  complaint *before* PayPal sees it is the part nobody else is building.

Where we are weak and must compensate: dispute management is a crowded
commercial category. **Always lead with prevention, never with "we fight
chargebacks."**

---

## 4. User stories

### Customer
- As a subscriber, I can open a link from my email and see my plan, next
  billing date, and payment history without creating a password.
- As a subscriber, I can type "I think I was charged twice this month" and get
  a real response, not a ticket number.
- As a subscriber, I can see the merchant's reply in a thread.

### Owner
- As an owner, I see a queue of cases ordered by deadline, so the urgent
  dispute is always at the top.
- As an owner, I open a case and see: what the customer said, what kind of
  problem the AI thinks it is, what evidence we have and what is missing, and
  a draft reply.
- As an owner, I can edit the draft, then approve. Nothing is sent until I do.
- As an owner, I can see how much money this has recovered or protected.

---

## 5. Architecture

### 5.1 Services

One backend, two front-ends. Do not split into microservices.

```
┌─ Customer portal (token link, no password)
├─ Owner dashboard (authenticated)
└─ API service ── PayPal gateway ── PayPal Sandbox
        │
        └─ Postgres / SQLite
```

Routes:

```
POST /webhooks/paypal          verify, store, enqueue, 200
GET  /portal/:token            subscription + history + thread
POST /portal/:token/report     customer files a complaint
GET  /api/cases                owner queue
GET  /api/cases/:id            case detail + AI analysis + draft
POST /api/actions/:id/approve  the gate
POST /api/actions/:id/reject
```

### 5.2 Data model

Seven tables.

```
subscriptions   paypal_subscription_id, customer_email, plan, status,
                next_billing, custom_id

transactions    paypal_sale_id, subscription_id, amount, currency,
                status, created_at

cases           id, subscription_id, source, reason_code, status,
                deadline, opened_at, resolved_at, outcome

evidence_items  case_id, kind, label, present (bool), value

actions         case_id, type, payload, proposed_by, status,
                approved_by, executed_at, paypal_response

messages        case_id, direction, body, sent_at

webhook_events  paypal_event_id (unique), event_type, raw, processed_at
```

`webhook_events.paypal_event_id` is the idempotency key. PayPal retries.

### 5.3 Case engine — the state machine

```
            ┌──────────┐
            │  intake  │  ← portal complaint OR dispute webhook
            └────┬─────┘
                 ▼
            ┌──────────┐
            │ triaged  │  reason_code assigned
            └────┬─────┘
                 ▼
         ┌────────────────────┐
         │ evidence_assembled │  checklist filled
         └────────┬───────────┘
                  ▼
            ┌──────────────┐
            │ recommended  │  draft + recommended action ready
            └──────┬───────┘
                   ▼
         ┌────────────────────┐
         │ awaiting_approval  │  ← THE GATE. Human required.
         └────────┬───────────┘
                  ▼
            ┌───────────┐
            │ executing │  PayPal call in flight
            └─────┬─────┘
                  ▼
            ┌──────────┐        ┌────────────┐
            │ resolved │        │ escalated  │
            └──────────┘        └────────────┘
```

Both entry points write the same row. A portal complaint enters as
`source=customer`. A `CUSTOMER.DISPUTE.CREATED` webhook enters as
`source=paypal_dispute` with `deadline` set.

**This is the architectural idea worth explaining in the demo video:**
deflection and dispute response are not two features. They are the same
pipeline entered at different stages. A deflected case never reaches
`escalated`. That is the product.

### 5.4 Rules layer — runs before any AI

Deterministic. No model call. Document this in the README, because knowing
where *not* to use AI is an engineering signal.

- **Duplicate charge:** same payer, same amount, inside a short window. Pure
  SQL over `transactions`.
- **Failed payment:** retry count and dunning state from the subscription.
- **Deadline clock:** days remaining; drives queue ordering.

### 5.5 AI layer — three bounded jobs

Each returns schema-constrained JSON. Never free prose into the database.

**Job 1 — Triage**

```
input:  complaint text, subscription context, recent transactions
output: { reason_code, transaction_ref, remedy_sought,
          urgency, summary }
```

`reason_code` is one of: `INR`, `SNAD`, `UNAUTHORIZED`, `DUPLICATE`,
`SUBSCRIPTION_CANCEL`.

**Job 2 — Evidence assessment**

```
input:  reason_code, available evidence items
output: { present: [...], missing: [...],
          strength: "4 of 6", rationale }
```

> **Design decision — read this.** We do **not** output a win probability.
> We have no historical outcome data, so any percentage would be invented, and
> payments-literate judges will see through it immediately. Instead we check
> what evidence exists against what PayPal actually requires for that specific
> reason code. "Missing: proof of delivery" is more useful to a merchant than
> "73% win chance", and it is defensible under questioning.

**Job 3 — Drafting**

Two prompt variants:
- buyer-facing resolution message (used in inquiry stage and in deflection)
- dispute evidence text (used when escalated)

Both conditioned on reason code, evidence assessment, and merchant tone.

### 5.6 Approval gate

```
actions {
  case_id, type, payload,
  proposed_by: 'ai',
  status: pending | approved | rejected | executed,
  approved_by, executed_at, paypal_response
}
```

Action types: `SEND_BUYER_MESSAGE`, `ISSUE_REFUND`, `MAKE_OFFER`,
`PROVIDE_EVIDENCE`, `ACCEPT_CLAIM`, `CANCEL_SUBSCRIPTION`.

**No PayPal write endpoint is called unless `status = approved`.** There is
exactly one function in the codebase that executes actions, and it checks
status first. Everything else enqueues.

This table is also the audit log and the trust story. Show it on screen.

---

## 6. PayPal integration

### 6.1 Endpoints

| Need | Endpoint |
|---|---|
| Subscription state | `GET /v1/billing/subscriptions/{id}` |
| Suspend / cancel | `POST .../suspend`, `.../cancel` |
| Refund a subscription payment | `POST /v1/payments/sale/{id}/refund` |
| Dispute list / detail | `GET /v1/customer/disputes`, `/{id}` |
| Reply during inquiry | `POST /v1/customer/disputes/{id}/send-message` |
| Submit evidence | `POST /{id}/provide-evidence` |
| Offer resolution | `POST /{id}/make-offer` |
| Concede | `POST /{id}/accept-claim` |
| Verify webhook | `POST /v1/notifications/verify-webhook-signature` |

Sandbox-only, for the seeder: create dispute, create chargeback, change
dispute reason, update dispute status, settle dispute. These let us drive a
full end-to-end demo including the merchant *winning*.

### 6.2 Webhooks to subscribe

```
CUSTOMER.DISPUTE.CREATED              opens a case + deadline
CUSTOMER.DISPUTE.UPDATED              stage / deadline change
CUSTOMER.DISPUTE.RESOLVED             closes case, feeds ledger
BILLING.SUBSCRIPTION.PAYMENT.FAILED   opens a dunning case
PAYMENT.SALE.COMPLETED                every renewal → transactions table
PAYMENT.SALE.REFUNDED                 confirms our refund executed
PAYMENT.SALE.REVERSED                 money already gone
BILLING.SUBSCRIPTION.ACTIVATED        state sync
BILLING.SUBSCRIPTION.CANCELLED        churn signal
BILLING.SUBSCRIPTION.SUSPENDED        usually follows repeated failure
BILLING.SUBSCRIPTION.EXPIRED          terminal, stops dunning clock
```

**`PAYMENT.SALE.COMPLETED`, not `PAYMENT.CAPTURE.COMPLETED`.** Subscriptions
produce `sale` objects. Subscribe to the capture events and your dashboard
stays empty.

Skip `BILLING.PLAN.*` and `CATALOG.PRODUCT.*` — plan administration, no
pipeline reacts to them.

### 6.3 Known gotchas — read before writing code

1. **Transaction Search is not real-time.** It takes up to three hours for
   executed transactions to appear in the list-transactions call, and if the
   REST app was used for other requests before the permission was added, it
   can take up to nine hours before a new token works — until then you get
   permission denied. **Webhooks are the source of truth. Transaction Search
   is backfill only.** Add the permission to the app on day one.
2. **Events arrive out of order.** `BILLING.SUBSCRIPTION.ACTIVATED` can land
   after the first `PAYMENT.SALE.COMPLETED`. Upsert on subscription ID and
   re-fetch from the API when you need authoritative state.
3. **Set `custom_id` when creating the subscription.** It comes back in
   webhook payloads and saves reverse-mapping PayPal IDs to our rows.
4. **Re-fetch dispute details on CREATED.** Read `seller_response_due_date`
   from `GET /v1/customer/disputes/{id}`, not from the webhook payload. Queue
   ordering depends on it.
5. **Creating disputes as a buyer needs extra setup.** Buyer-side credentials
   and a `PayPal-Auth-Assertion` header. Budget half a day. Do it day one.
6. **Cache the OAuth token.** Tokens last hours. Re-authing per call will rate
   limit us mid-demo.

---

## 7. Security

- Webhook signature verified on every request before anything is stored.
- Portal tokens are signed, scoped to one subscription, and expire.
- Secrets in environment variables. No credentials in the repo — judges read
  it.
- The approval gate is enforced server-side, not in the UI.

---

## 8. Demo script (3 minutes maximum)

The video must be under three minutes and judges are not required to watch
past that. Plan every second.

```
0:00  Problem, 20 seconds. One sentence, one number.
0:20  Customer portal. Type a complaint in plain words. Submit.
0:40  Dashboard: case appears, AI triage visible, evidence checklist,
      draft reply. Owner edits one line. Approves.
1:10  Message sent via PayPal API. Customer sees the reply.
      "No dispute was ever opened." ← the money shot
1:30  Second path: seeder fires a real sandbox dispute.
      Webhook lands, deadline clock starts, evidence assembled,
      owner approves evidence submission.
2:10  Settle dispute in merchant favour. Case closes.
2:25  Recovery ledger: cases deflected, disputes won, money protected.
2:45  One line on architecture. End.
```

Record this on day 9, not day 10.

---

## 9. Build order — 10 days

| Days | Work |
|---|---|
| 1–2 | Credentials, Transaction Search permission, webhook receiver + signature verification, public tunnel, seeder, schema |
| 3–4 | Case engine, rules layer, dispute ingestion, deadline clock |
| 5–6 | The three AI jobs with schema-constrained output |
| 7–8 | Owner dashboard first, customer portal second (portal can be 3 screens) |
| 9 | Recovery ledger, polish, record video |
| 10 | Buffer, README, licence, deploy, submit |

**Build the dispute path end to end before anything pretty.** If day 8 goes
wrong we still have a working demo.

---

## 10. Submission checklist

- [ ] Working demo — hosted URL or complete run instructions
- [ ] Public repo (GitHub / GitLab / Bitbucket) with a visible open-source licence
- [ ] Text description
- [ ] List of tools used
- [ ] Public YouTube video, under 3 minutes, showing it functioning end to end
- [ ] Demo stays live and free to judges through 15 December 2026
- [ ] No third-party trademarks or copyrighted music in the video

---

## 11. Open questions

- Which model and provider for the three AI jobs?
- Hosting: Render has sponsor credits available.
- Do we attempt file-upload evidence, or text evidence only? (Text only is
  probably the right call for ten days.)
- Postgres or SQLite? SQLite is faster to ship; Postgres looks more serious.