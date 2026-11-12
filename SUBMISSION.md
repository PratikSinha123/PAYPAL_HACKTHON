# ChargeGuard AI - Hackathon Submission Text

Paste-ready copy for the hackathon submission form (e.g. Devpost / Hackathon Dashboard).

- **Repo:** https://github.com/PratikSinha123/PAYPAL_HACKTHON (MIT licence)
- **Note:** Fill the **Live Demo URL** (your Render deployment) and **Demo Video link** (YouTube, under 3 minutes) directly in the respective submission form fields when submitting.

## Tagline
Resolve the complaint before it becomes a PayPal dispute. The AI proposes; the owner approves; only then does PayPal get called.

## The problem
A small business selling subscriptions through PayPal has no staff for three recurring problems: a renewal fails and nobody
notices, a customer is charged twice and emails into a void, or a customer opens a dispute and the business has days to
answer with evidence or loses the money automatically. A dispute you win still costs fees and hours. One that never opens costs nothing.

## What it does
- **Customer portal** (no password, signed expiring link): the customer sees their plan and payments and describes a problem in plain words. No forms, no ticket numbers.
- **Owner dashboard:** every problem is a *case* in a deadline-ordered queue. For each case the AI classifies the problem (INR, SNAD, UNAUTHORIZED, DUPLICATE, SUBSCRIPTION_CANCEL), checks which evidence is actually on file, drafts a reply and proposes one action. The owner edits the draft and approves.
- **One pipeline, two entry points:** a portal complaint and a real PayPal dispute webhook write the same case. A deflected complaint never reaches PayPal's dispute stage. That is the product.
- **Recovery ledger:** complaints resolved before a dispute, disputes won/lost/open, amounts protected, at risk, lost and refunded, all counted from real rows.

## How it is built
- Fastify + TypeScript + SQLite (better-sqlite3). One backend, two static pages. No microservices.
- **PayPal platform:** Subscriptions API (create/approve/state), Webhooks (every request verified with `verify-webhook-signature` before anything is stored; idempotent on the event id), Disputes API (dispute detail for the authoritative seller deadline; message, offer, evidence and accept-claim endpoints for approved actions), Payments sale refund, plus the sandbox personal/business accounts and webhook simulator.
- **Deterministic rules run before any AI:** duplicate charge detection is pure SQL, and so are the failed-payment count and the deadline clock. Knowing where not to use AI is part of the design.
- **Three bounded AI jobs** (triage, evidence assessment, drafting), each returning zod-validated JSON, never free prose into the database. Evidence strength is a factual "X of Y records on file", never an invented win probability, and anything the system cannot verify is marked missing.
- **Approval gate:** the AI only inserts `pending` rows. Exactly one function executes actions and it refuses anything not `approved`. The actions table is the audit log. The gate is enforced on the server, not in the UI, and AI-proposed payloads are re-validated (refunds pinned to the case's own sale and capped at its amount).

## Honest notes
- Everything runs in the **PayPal sandbox** with fake money.
- The AI jobs call a live model (Gemini). If it is unreachable or rate-limited, a rules fallback keeps cases moving, and the dashboard labels those proposals "NO LIVE MODEL - rules fallback". It is never presented as AI.
- On the free hosting plan the database resets when the service restarts.

## Challenges
- Webhooks arrive out of order and are retried, so every handler is an idempotent upsert.
- Subscriptions produce `sale` objects, not `capture` objects, so the obvious capture webhooks would have left the dashboard empty.
- Sandbox disputes can only be opened by the buyer account, so the dispute path was driven from the buyer's Resolution Center.
- Keeping an AI from touching money: drafts stay invisible to the customer until the owner approves, and a failed PayPal call stays retryable instead of pretending to succeed.

## What's next
Backfill history with Transaction Search, a dunning workflow for failed renewals, file-upload evidence, and per-merchant tone and policy settings.

## Built with
TypeScript, Node.js, Fastify, SQLite (better-sqlite3), zod, Tailwind CSS, Google Gemini (OpenAI-compatible API), PayPal REST APIs and Webhooks (Subscriptions, Disputes, Payments), Render.

## 3-minute demo script
1. **0:00** One sentence on the problem. 2. **0:20** Portal: type "I think I was charged twice this month", send.
3. **0:40** Dashboard: the case appears; show triage, the evidence checklist (present vs missing), the draft and the proposed action. Edit one line. Approve.
4. **1:10** Back in the portal the reply appears. "No dispute was ever opened."
5. **1:30** Second path: a real sandbox dispute arrives by webhook, deadline countdown starts, evidence text is drafted, owner approves.
6. **2:10** Settle in the merchant's favour; the case closes. **2:25** Recovery ledger. **2:45** One line on architecture.
