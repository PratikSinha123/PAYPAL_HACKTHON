# ChargeGuard AI 🛡️
> **Autonomous Pre-Dispute Deflection & Case Engine for PayPal Subscriptions**  
> *PayPal AI Hackathon 2026 Submission*

[![CI](https://github.com/PratikSinha123/PAYPAL_HACKTHON/actions/workflows/ci.yml/badge.svg)](https://github.com/PratikSinha123/PAYPAL_HACKTHON/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)

---

## 💡 The Core Problem: Why ChargeGuard?

Small businesses running subscription models on PayPal face three recurring nightmares:
1. **Accidental Duplicate Charges:** Buyers hit renewal errors or submit twice, emailing support angrily or heading straight to PayPal to dispute.
2. **Payment Failures & Churn:** Cards expire or fail silently; merchants have no automated dunning radar.
3. **Formal PayPal Disputes:** Once a dispute or chargeback is filed, merchants face strict deadlines, chargeback penalty fees, and labor-intensive evidence compilation.

**The Solution:**
> **A dispute you win still costs fees and hours. A dispute that never opens costs nothing.**

ChargeGuard AI intercepts customer billing complaints *before* they escalate to formal PayPal disputes, while also managing formal disputes end-to-end when they do occur.

---

## 🏛️ Architectural Principle: The Golden Rule

> **The AI never touches money directly.**  
> The AI triages, gathers evidence, drafts messages, and proposes actions. A human owner reviews and approves with one click. **Only then does ChargeGuard execute write operations against PayPal.**

```
                                  [ The Customer ]
                                         │
                         (Passwordless Tokenized Portal)
                                         │
                                         ▼
                                   ┌───────────┐
      [ PayPal Webhooks ] ───────► │  INTAKE   │
   (Dispute, Sale, Failed)         └─────┬─────┘
                                         ▼
                                  Deterministic SQL Rules
                             (Duplicates, Dunning, Deadlines)
                                         ▼
                                 ┌───────────────┐
                                 │   AI LAYER    │
                                 │ Job 1: Triage │
                                 │ Job 2: Evid.  │
                                 │ Job 3: Draft  │
                                 └───────┬───────┘
                                         ▼
                           ╔═══════════════════════════╗
                           ║     THE APPROVAL GATE     ║ ◄─── Owner Reviews
                           ║  (Human-in-the-Loop Gate) ║      & Approves
                           ╚═════════════╤═════════════╝
                                         │  (Approved)
                                         ▼
                             ┌───────────────────────┐
                             │    PAYPAL EXECUTOR    │
                             │  Refund / Msg / Evid  │
                             └───────────┬───────────┘
                                         ▼
                              [ PayPal Sandbox API ]
```

---

## 🌟 Key Features

### 1. Two-Sided System
- **Customer Portal (`/portal/:token`):** Passwordless, HMAC-signed magic link for subscribers. Displays live subscription status, renewal date, past transactions, and a plain-English problem intake box.
- **Owner Dashboard (`/`):** Command center with live financial recovery KPIs, priority-sorted case queues (with countdown clocks for seller response deadlines), and deep-inspector cards for AI triage and evidence.

### 2. Deterministic Rules First (No Hallucination)
Before any AI model is invoked, pure SQL rules run over the SQLite transaction history:
- Instant duplicate charge detection (same subscription, identical amount within 48h).
- Dunning status & retry tracking for failed subscription billings.
- Dynamic deadline sorting based on PayPal dispute `seller_response_due_date`.

### 3. Three Schema-Constrained AI Bounded Jobs
ChargeGuard uses structured JSON schemas (via Zod + Gemini / OpenAI-compatible endpoint):
- **Job 1: Triage:** Classifies grievance into standard reason codes (`DUPLICATE`, `INR`, `SNAD`, `UNAUTHORIZED`, `SUBSCRIPTION_CANCEL`), identifies transaction references, and flags urgency.
- **Job 2: Factual Evidence Assessment:** Matches available ledger data against PayPal's dispute evidentiary requirements.  
  *Design Decision:* We **refuse** to show synthetic "win probability percentages." Instead, we provide an honest, actionable factual checklist (e.g. `Strength: 3 of 4: Missing Proof of Delivery`).
- **Job 3: Drafting & Recommendation:** Produces dual responses—a customer-facing resolution message (conditioned on merchant tone: *conciliatory*, *professional*, or *firm*) and structured dispute evidence text, paired with a proposed PayPal action (`ISSUE_REFUND`, `SEND_BUYER_MESSAGE`, `PROVIDE_EVIDENCE`, etc.).

### 4. Robust PayPal Sandbox Integration
- **Subscriptions API:** `GET /v1/billing/subscriptions/{id}`, `suspend`, `cancel`
- **Payments API:** `POST /v1/payments/sale/{id}/refund`
- **Disputes API:** `GET /v1/customer/disputes`, `send-message`, `provide-evidence`, `make-offer`, `accept-claim`
- **Webhook Verifier:** Cryptographic signature verification via `POST /v1/notifications/verify-webhook-signature`
- **Event Dispatcher:** 11 webhook event types handled idempotently with SQLite unique constraint deduplication.

---

## 🚀 Quickstart & Setup

### Prerequisites
- Node.js 20+ or 22+
- npm or pnpm
- PayPal Developer Sandbox credentials

### 1. Clone & Install
```bash
git clone https://github.com/PratikSinha123/PAYPAL_HACKTHON.git
cd PAYPAL_HACKTHON/server
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` in the root directory:
```bash
cp ../.env.example ../.env
```
Edit `../.env` with your sandbox credentials:
```env
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
PAYPAL_WEBHOOK_ID=your_sandbox_webhook_id
PAYPAL_BASE=https://api-m.sandbox.paypal.com

PORTAL_SECRET=any_random_secret_string
OWNER_PASSWORD=choose_a_dashboard_password   # you type this to sign in to the Owner Dashboard
DB_PATH=chargeguard.db
PORT=3000

# AI Provider (Gemini / OpenAI compatible)
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_API_KEY=your_gemini_or_openai_key
AI_MODEL=gemini-3.5-flash

# true = skip the model and use the keyword-rules fallback (offline tests only)
AI_MOCK=false
```

### 3. Run Development Server
```bash
npm run dev
```
Open **http://localhost:3000/** and sign in with your `OWNER_PASSWORD` to view the Owner Dashboard.

### AI transparency
The three AI jobs call a live model (Gemini by default; any OpenAI-compatible endpoint works). If the model is
unreachable, rate-limited, or no key is set, a deterministic keyword-rules fallback keeps the pipeline running so
cases are never stuck. **The fallback is never silent:** it logs a warning, and the dashboard labels the proposal
*"NO LIVE MODEL - rules fallback"* instead of *"AI model"*. Every action still goes through the same human approval gate.

### Deploy (Render)
`render.yaml` is a Render blueprint: **New + > Blueprint**, select this repo, fill the PayPal and AI secrets, deploy.
Then set the PayPal sandbox webhook URL to `https://<your-service>.onrender.com/webhooks/paypal` and copy the new
webhook ID into `PAYPAL_WEBHOOK_ID`. The free plan's disk is ephemeral, so stored cases reset when the service restarts.

---

## 🧪 Testing

ChargeGuard has full unit, state machine, and integration test coverage:

```bash
# Run database schema & idempotency tests
npm test

# Run Case Engine, Rules Layer, & Webhook Dispatcher tests
npm run test:case

# Run AI Jobs, Schema Validation, & Approval Gate tests
# (calls the live model if AI_API_KEY is set; AI_MOCK=true runs it offline)
npm run test:ai

# Run TypeScript compile check
npm run typecheck
```

---

## 🎬 Reproducing the Demo

### Scenario A: Pre-Dispute Deflection (Customer Portal)
1. In the Dashboard header, click **"+ Portal Link Generator"** and click **"Generate Tokenized Magic Link"**.
2. Open the generated portal URL.
3. In the problem box, type:
   > *"I was charged $9.99 twice this month, please refund the second charge."*
4. Click **Submit Problem Report**.
5. Switch to the Owner Dashboard:
   - Case appears in real time.
   - AI Job 1 triages as `DUPLICATE` with `HIGH` urgency.
   - AI Job 2 validates transaction evidence.
   - AI Job 3 drafts a polite buyer reply and queues an `ISSUE_REFUND` action.
6. Click **Approve & Execute via PayPal**.
7. On approval the owner's edited reply appears in the customer's portal thread, and the `ISSUE_REFUND` action is sent to PayPal's sale-refund API. The customer never saw the draft before you approved it, and **no dispute was ever filed with PayPal.**

### Scenario B: Formal PayPal Dispute Ingestion
1. As the sandbox **personal** (buyer) account, open a dispute on a subscription payment in the Resolution Center (sandbox.paypal.com > Resolution Center). PayPal sends `CUSTOMER.DISPUTE.*` webhooks to ChargeGuard.
2. ChargeGuard verifies the webhook signature, creates a dispute case, fetches the authoritative seller due date, and calculates remaining hours.
3. The case is ranked at the top of the **Priority Case Queue** with an active deadline countdown.
4. AI generates required representment evidence text based on reason code (`INR` / `SNAD`).
5. Owner reviews, clicks **Approve**, and evidence is automatically transmitted to PayPal's Dispute Resolution Center.

---

## 📁 Repository Structure

```
├── .github/workflows/
│   └── ci.yml                 # Automated CI running tests & typechecks
├── server/
│   ├── public/
│   │   ├── index.html         # Owner Dashboard (TailwindCSS)
│   │   └── portal.html        # Customer Resolution Portal
│   ├── src/
│   │   ├── ai.ts              # Resilient AI client with fallback mock
│   │   ├── ai-jobs.ts         # The 3 bounded AI jobs (Triage, Evidence, Drafting)
│   │   ├── case-engine.ts     # State machine & Approval Gate lifecycle
│   │   ├── db.ts              # SQLite database schema (7 relational tables)
│   │   ├── dispatcher.ts      # Webhook ingestion & event routing
│   │   ├── dispute.ts         # Sandbox dispute simulation tool
│   │   ├── executor.ts        # The ONLY PayPal write execution module
│   │   ├── index.ts           # Fastify application & API routes
│   │   ├── paypal.ts          # PayPal OAuth, disputes, & webhook verifier
│   │   ├── portal.ts          # HMAC token generator & portal data handler
│   │   ├── rules.ts           # Pure SQL rules (duplicates, dunning, ledger)
│   │   └── seed.ts            # Sandbox seeding helper
│   └── package.json
├── plan.md                    # Detailed hackathon specification & audit
└── README.md
```

---

## 🔒 Security & Compliance

- **Zero Autonomous Writes:** PayPal write actions are strictly gated by `status = 'approved'`.
- **HMAC Signed Tokens:** Customer portals use time-bounded tokens with timing-safe comparison.
- **Webhook Signature Verification:** Verified against PayPal certificates on every incoming payload.
- **Strict Data Integrity:** SQLite WAL mode with foreign keys and SQL transaction boundaries.

---

## ⚖️ License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.
