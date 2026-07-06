# Meta Ads — Phase 2 Plan: the real Graph API client

## Context

Step 0 shipped: worker agents can now create/launch/pause/optimize ad campaigns
through the `ads` tool namespace, and the whole loop (gating, monthly cap,
auto-pause, ROAS reallocation, ledger audit) runs end-to-end on the offline
`LocalAds` mock. The one thing standing between that and **real ad spend** is the
`MetaAds` class in `apps/gateway/src/providers/ads.ts:209`, which is a scaffold —
every method throws `meta ads … not implemented yet (Phase 2)`.

This plan covers implementing that client against the Meta Marketing (Graph) API
so `create → launch → set_budget → pause → insights` run against a connected Meta
ad account. Everything upstream (tools, cap sync, optimizer, attribution) already
expects the `AdsProvider` shape and needs no change — this is a pure seam fill-in.

**Out of scope for this step** (tracked separately):
- The owner-facing **OAuth connect flow** (Step 2) — here credentials are
  provisioned manually into the vault so we can build/test the client first.
- Meta **Pixel / Conversions API** attribution (Step 4) — we keep the existing
  `?c=<campaignId>` last-click attribution for now.
- Google Ads or any second platform.

---

## Prerequisite (owner, one-time): provision a Meta app + sandbox ad account

You don't have a Meta account yet, so this is step one and it's **manual, done in
the Meta UI — not code**. Do it against a **sandbox ad account** first (Meta's
sandbox mode simulates delivery with **zero real spend**, perfect for dev):

1. **Meta app** — create a *Business*-type app at `developers.facebook.com`, add
   the **Marketing API** product.
2. **Facebook Page** — create/associate a Page. A Page id is **required** to
   build an ad creative; there's no way around it.
3. **Ad account** — in Meta Business Suite, note the ad account id in `act_<digits>`
   form. Create a **sandbox** ad account for development.
4. **Access token** — generate a **System User** token (long-lived, non-expiring
   is the goal) with scopes: `ads_management`, `ads_read`, `business_management`,
   `pages_read_engagement`.
5. **Wire it in** (dev): set `OPENCORP_SECRET__META_ACCESS_TOKEN=<token>` in
   `.env`, and set on the conglomerate row `meta_ad_account_id = act_…` and the
   new `facebook_page_id = <page id>`.

Until these three values exist for a conglomerate, `adsFor()` keeps returning the
mock, so nothing changes for laptop dev or other conglomerates.

---

## Meta object mapping (what each `AdsProvider` method does)

A single Meta ad is a 4-object graph. `createCampaign` builds all four, PAUSED,
under the ad account (`act_<id>`), against Graph API **v21.0**:

| Our method | Graph call(s) |
|---|---|
| `createCampaign` | `POST act_<id>/campaigns` (objective, `status=PAUSED`, `special_ad_categories=[]`) → **campaign id**. `POST act_<id>/adsets` (references campaign id, `daily_budget`/`lifetime_budget` in cents, minimal `targeting` = Advantage+/broad, `billing_event`, `optimization_goal`, `status=PAUSED`) → **ad set id**. If `creative.imageUrl`: `POST act_<id>/adimages` → **image_hash**. `POST act_<id>/adcreatives` (`object_story_spec` with `page_id`, `link_data`: message/headline/`link=creative.linkUrl`/image_hash) → **creative id**. `POST act_<id>/ads` (adset id + creative id, `status=PAUSED`) → **ad id**. |
| `setBudget` | `POST <adset_id>` with `daily_budget` or `lifetime_budget`. |
| `launch` | `POST <campaign_id>` `status=ACTIVE` **and** `POST <adset_id>` `status=ACTIVE`. |
| `pause` | `POST <campaign_id>` `status=PAUSED` (pausing the campaign halts delivery). |
| `insights` | `GET <campaign_id>/insights?fields=spend,impressions,clicks&time_range={since,until}&time_increment=1`, mapped to `DailySpend[]` (spend → cents). |

**`providerRef`** — today it's a single string. A Meta campaign needs the
campaign id (launch/pause/insights) **and** the ad set id (budget/launch). Store
both: encode `providerRef` as `meta:<campaignId>:<adsetId>` and parse it in each
method. (Alternative: a JSON blob column — heavier; the delimited string keeps the
existing `provider_ref text` column and the mock's `local:campaign:<id>` format
untouched.)

---

## Files to change

1. **`apps/gateway/src/providers/ads.ts`** — the bulk of the work.
   - Implement `MetaAds` mirroring `StripePayments` (`providers/payments.ts:89`):
     a private `graph(path, method, params)` helper doing
     `fetch("https://graph.facebook.com/v21.0/" + path, …)`, Bearer token, form
     body, throwing a typed error on `!res.ok`.
   - Constructor gains the Page id: `new MetaAds(token, adAccountId, pageId)`.
   - `adsFor(...)` gains a `facebookPageId` param; only returns `MetaAds` when
     token **and** ad account **and** page id are all present, else the mock.
   - `providerRef` encode/parse helpers.
2. **`apps/gateway/src/tools.ts`** — `adsContext()` (line ~99) also selects
   `facebook_page_id`; every `adsFor(...)` call passes it through.
3. **`apps/gateway/src/ads.ts`** — `syncCompanyAdSpend` / `optimizeCompanyAds`
   select + pass `facebook_page_id` to `adsFor(...)` (currently pass only
   `meta_ad_account_id`).
4. **`packages/schema/src/tables.ts`** — add `facebookPageId: text("facebook_page_id")`
   to `conglomerates`, next to `metaAdAccountId`. Then `bun run db:generate` to
   emit the migration and `bun run db:migrate` to apply.
5. **`.env.example`** — document `facebook_page_id`, the sandbox-account workflow,
   and the Graph API version.

---

## Verification

**Unit (no Meta account needed) — the gate for merging the code:**
Follow the `globalThis.fetch` stub pattern in
`apps/gateway/test/providers.test.ts:90`. Add tests asserting `MetaAds`:
- `createCampaign` issues the campaign→adset→(adimages)→adcreative→ad sequence
  with the right bodies, and returns a `meta:<c>:<a>` `providerRef`;
- `launch`/`pause`/`setBudget` hit the right ids with the right status/budget;
- `insights` parses a stubbed Graph response into `DailySpend[]` (spend in cents);
- a `!ok` Graph response surfaces as a thrown error (so `syncCompanyAdSpend`'s
  per-campaign `try/catch` skips it rather than silently no-oping);
- `adsFor` still returns the **mock** when the page id is missing.

**Integration (needs the sandbox account from the Prerequisite):**
Point one `bounded` company at the sandbox `act_…` + page id, then run a
Meta-mode variant of `apps/gateway/scripts/ads-demo.ts`: create → launch →
`get_campaign_insights` → cap sync → auto-pause. Confirm in **Meta Ads Manager**
that the campaign appears PAUSED then ACTIVE, that budget edits land, and that
`ad_spend` mirrors what Meta reports. Sandbox = no real charge.

**Regression:** the offline mock stays the default, so `bun test` and laptop
`bun run dev` are unaffected; existing `ads-demo.ts` must still pass unchanged.

---

## Open decisions (worth settling before coding)

1. **Creative image** — upload `imageUrl` to `/adimages` for an `image_hash`
   (recommended; robust), vs. passing a raw `picture` URL in `link_data`
   (simpler, but Meta may reject/hotlink poorly). *Lean: image_hash.*
2. **Targeting default** — Advantage+ audience (let Meta optimize) vs. a broad
   geo/age default we set. *Lean: Advantage+ for v1; expose targeting to agents
   later.*
3. **Graph API version pin** — pin `v21.0` in a const; revisit on Meta deprecation.
4. **`providerRef` encoding** — delimited string `meta:<c>:<a>` (chosen) vs. JSON
   column migration.
