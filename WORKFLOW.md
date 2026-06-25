# Dev workflow — one feature at a time

> `DEPLOY.md` = how to stand up a fresh instance (once). **This file = how to ship
> a single change** onto the running prod instance, cleanly and repeatably.

**Principle: 1 ticket → 1 branch → 1 PR → 1 deploy.** Never mix two features in a
branch. If a "feature" needs a schema change *and* UI *and* a worker change,
that's fine — it's still one ticket as long as it's one shippable unit.

---

## The loop

### 1. Ticket — define the unit before touching code
Tickets come **straight from chat** — the owner drops an idea, Claude restates it
as a one-paragraph ticket and gets a 👍 before writing code. Keep it small enough
to ship in a day. The restatement should pin down:

```
What:      <verb> <thing>  (e.g. "Self-financing: reinvest revenue into credits")
Why:       the user-visible problem this solves
Scope:     what's in / explicitly out
Done when: the acceptance check (how we'll know it works in prod)
```

(No GitHub Issues / no tracker — the repo is public and the backlog stays in chat
by choice. The "Done when" line is what later gets verified in step 8.)

### 2. Branch off master
```sh
git checkout master && git pull
git checkout -b feat-<slug>      # or fix-<slug>
```

### 3. Build + test locally
```sh
bun run dev          # Postgres + Temporal + services on the laptop
bun test             # must stay green
```
- New logic → add a test. Convention here: **extract the pure decision into a
  function and unit-test that** (no live-DB tests). See `workflows/src/reinvest.ts`
  (`planReinvestment`, `drainSources`) + `workflows/test/reinvest.test.ts`.
- Schema change → `bun run db:generate` to create the migration, commit it with the code.

### 4. Commit + push (push early, push often)
```sh
git commit            # message ends with the Co-Authored-By trailer
git push -u origin feat-<slug>
```
Pushing a branch is cheap and safe — it does **not** deploy. Do it after each commit.

### 5. PR
```sh
gh pr create --base master --fill   # body: restate What / Why / Done-when
```
Optionally `/code-review` before merging.

### 6. Merge to master — the deliberate step
Merging is what makes it prod. Do it only when the PR is green and reviewed.
```sh
gh pr merge <n> --merge
```
On merge:
- **Frontend (dashboard):** Vercel auto-deploys from master. Nothing to do.
- **Backend (worker/api/gateway/deployd):** does NOT auto-deploy → step 7.

### 7. Deploy the backend (only if the change touched backend / schema)
```sh
ssh opencorp-vps 'cd /opt/opencorp && ./scripts/deploy-prod.sh'
```
One script: pull → build → migrate → recreate app services (infra untouched). It
prints service status + a health check at the end.

### 8. Verify in prod
Hit the "Done when" check from the ticket. For anything touching money/credits,
do the real path once (e.g. top-up with Stripe test card `4242 4242 4242 4242`).
Then close the issue.

---

## Rollback
Code is immutable per commit, so rolling back = redeploy the previous good commit:
```sh
ssh opencorp-vps 'cd /opt/opencorp && git merge --ff-only <good-sha> 2>/dev/null || git reset --hard <good-sha>; ./scripts/deploy-prod.sh'
```
Migrations don't auto-revert — write a forward "fix" migration rather than
down-migrating in prod. (Additive migrations are usually safe to leave in place.)

---

## When to batch vs split
- **Split** (default): each user-visible behaviour = its own ticket/branch/deploy.
  Easier to review, verify, and roll back.
- **Batch** only the truly inseparable: a migration + the code that depends on it
  ship together (one PR), because half-deployed they'd break.
