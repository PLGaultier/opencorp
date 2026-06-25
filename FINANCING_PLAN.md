# Financing Loop — Plan (drafted 2026-06-24)

> Next dev priority: **close the financing loop** so a company doesn't freeze
> after its €5 onboarding grant. Turns the project from "demo that freezes" into
> "a company that can actually run (and self-fund)."

## Progress log (2026-06-25)
- **Decisions locked:** conversion = **1:1 full** (no platform margin on the
  internal reinvest; the cut is taken at cash-out). Trigger preference = **owner %
  auto-policy**. ⚠️ See "decision drift" below — the already-built code uses
  *auto-when-low*, not a %-policy.
- **Phase 1 polish — DONE (uncommitted):** the "out of credits" brief now
  deep-links to `${WEB_ORIGIN}/credits` (`workflows/src/taskActivities.ts`); added
  a `revenue_reinvest` → "Self-financed (revenue)" label on `/credits`
  (`apps/web/app/credits/page.tsx`). Still TODO: the live prod top-up test
  (browser, test card) — needs a human.
- **Phase 2 — already BUILT (uncommitted, tests green):**
  `workflows/src/reinvest.ts` + `reinvest.test.ts`, wired into `runCeoPlanning`,
  migration `0013` adds the `revenue_reinvest` credit_reason. It's **auto-when-low**
  (refill when wallet < `REINVEST_MIN_CENTS`≈160 up to `REINVEST_TARGET_CENTS`=1000,
  per-cycle cap 2000), 1:1, atomic, drains companies largest-first, surplus stays
  withdrawable.
- **Decision drift — RESOLVED:** keep **auto-when-low** (you confirmed). "owner %
  policy" stays a possible later opt-in knob.
- **Tested before commit (2026-06-25):** no DB is available locally (no docker/pg)
  and the repo has *zero* DB-backed tests by convention — pure logic is extracted
  and unit-tested instead. So `reinvestRevenue`'s previously-untested drain loop
  (multi-company split, largest-first, partial takes, zero-balance skips) was
  extracted into a pure `drainSources()` and covered. **14/14 workflows tests pass.**
  The live prod top-up (browser, test card) is the only remaining human step.

## Context — why this is the priority

Walking the value chain (observed while debugging CoolParis):

1. Sign up ✅ (after the cross-subdomain cookie fix, PR #3)
2. Found a company ✅
3. Company does work ✅ (after the credit-cap fix, PR #4) — **but capped at ~€5 then freezes**
4. Work produces value ⚠️ (bland, text-only sites)
5. Customers buy ⚠️ (Stripe just wired, test mode)
6. **Revenue refinances the company ❌ ← the missing link**

Two distinct money concepts in the system:
- **Credits** = the LLM wallet (internal cents, `credit_entries`) — pays Anthropic.
- **`real_balance_cents`** = the company's sales revenue.

A company that sells accumulates `real_balance_cents` but that **does not** top up
the credit wallet → even a selling company eventually freezes. And there's no
self-serve way to add credits once the €5 grant is spent.

## Stripe test-mode question — NOT blocking

- The **self-financing loop (revenue → credits) is pure internal accounting** —
  Stripe is not in that path at all. Test mode is irrelevant to it.
- **Owner top-up** uses Stripe → test mode is perfect for building/validating;
  only real money needs live mode later.
- The **only** thing blocked by "no dedicated business entity" is **cashing out to
  a real bank** (Stripe Connect + KYC + live) — that's the last mile, out of scope
  for this loop, already deferred.
- **Conclusion: build & validate the whole loop in test mode now.**

## Key discovery — the owner top-up loop already exists (~90%)

Already in code (mostly needs validation + polish, not building):
- `apps/gateway/src/billing-checkout.ts` — `createBillingCheckout` (Stripe Checkout
  Session or local), `creditWallet`, `activateSubscription`.
- API routes (`apps/api/src/index.ts`): `POST /api/conglomerates/:id/topup`,
  `POST /conglomerates/:id/subscribe`, `GET /api/conglomerates/:id/credits`,
  `GET /api/plans`, `POST /billing/grant-cycle`.
- Gateway Stripe webhook already handles `metadata.kind === "topup"` → `creditWallet`
  and `kind === "subscription"` → `activateSubscription` (`apps/gateway/src/app.ts`).
- Frontend page exists: `apps/web/app/credits/page.tsx`.
- Plans catalog: `apps/api/src/billing.ts` (`PLANS` free/builder/pro, `subscribe`,
  `runGrantCycle`, `PgBillingStore`).

So the **net-new build is Phase 2 (self-financing)**, not the top-up.

---

# The plan

## Phase 1 — Validate & finish the owner top-up (small, already ~built)
Goal: a dried-up company can be refilled → unblocks dogfooding.
1. **Test the existing flow in prod (test mode):** owner → `/credits` → top-up →
   Stripe Checkout → webhook → credits added. Confirm `metadata.kind=topup` flows.
2. **Close UX gaps:** does `/credits` show balance + a working top-up button? The
   "Out of credits" brief (shipped in PR #5) should **link to `/credits`**.
3. **Idempotency + amounts:** confirm a replayed webhook doesn't double-credit
   (keyed `stripe:evt:{id}` already exists).

## Phase 2 — The autonomous loop: revenue → credits (NEW, the "wow")
Goal: a company that sells **refinances itself**. No Stripe (internal accounting).
1. **Mechanism:** a ledger op converting `real_balance_cents` → conglomerate credits
   (debit balance, credit wallet, reason `adjustment` or new `revenue_reinvest`).
   1:1 conversion (credits are already real-money cents).
2. **Who decides? (TO DECIDE)**
   - **Owner auto-policy** ("reinvest X% of revenue into credits") — simple,
     predictable. *(recommended MVP)*
   - **CFO proposes** it at the heartbeat — more agentic, less predictable.
   - **Auto when low** (credits < threshold AND revenue available → top up).
3. **Guardrails:** cap on reinvestment (a company must not burn 100% of revenue on
   LLM); everything on the ledger for transparency.

## Phase 3 — Economic legibility
- Dashboard: credit balance + **burn rate + runway** (days left).
- **Email the owner** when credits are low → they top up (Phase 1) before the freeze.
- Link from the "paused — out of credits" brief.

---

## Sequencing
1. **Phase 1 first** (validate existing top-up) — foundation + unblocks dogfooding.
2. **Phase 2** — the differentiator; needs the two decisions below before coding.
3. **Phase 3** in parallel (small additions).

## Open decisions for Phase 2 — RESOLVED (2026-06-25)
1. **Who triggers reinvestment:** ~~owner auto-policy (%), CFO proposal, or auto-when-low?~~
   → built as **auto-when-low** (preference was owner %; see decision drift in the
   progress log — pending your confirm).
2. **Platform margin:** → **full 1:1 conversion** (no margin on the internal reinvest).

## First concrete step (tomorrow)
Verify the existing top-up flow in prod: generate a top-up checkout for the
conglomerate, pay with test card `4242 4242 4242 4242`, confirm credits land.
~5 min — tells us what already works vs what to finish, and primes the dogfood.

---

## Related state (context for tomorrow)
- Live prod: VPS `ssh opencorp-vps` (`/opt/opencorp`, prod compose + `.env.prod`),
  dashboard on Vercel (apex `opencorp.app`), API `api.opencorp.app`, gateway
  `gw.opencorp.app`.
- Stripe: **test mode** wired in prod (`OPENCORP_SECRET__STRIPE_SECRET_KEY` +
  `STRIPE_WEBHOOK_SECRET` in `.env.prod`; webhook → `gw.opencorp.app/webhooks/stripe`,
  event `checkout.session.completed`). A real Stripe test product exists for CoolParis.
- CoolParis conglomerate id: `8cff39a7-0034-4f09-9777-db3467b281a4`,
  company id: `5a216d4e-b59f-41ee-9bd8-5013009b8090`, `daily_credit_cap = 500`.
- Shipped today: PR #3 (cookie cross-subdomain), #4 (default cap 10→500), #5
  (skip heartbeat planning when out of credits). All merged + deployed.
- Owner-side TODO (you): Anthropic console spend limit (done), Chrome cache clear
  for login (Safari works).
