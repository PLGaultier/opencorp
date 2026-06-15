export { TaskRun, CompanyHeartbeat } from "./taskWorkflows";
export { Withdrawal } from "./withdrawalWorkflow";

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";

/**
 * CreateCompany (§6) — one prompt → named company, live site, repo, DB,
 * analytics, seeded tasks. Every activity is idempotent; Temporal retries
 * handle partial failures. Target P50 < 60 s.
 */

const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 5, initialInterval: "1s", backoffCoefficient: 2 },
});

export interface CreateCompanyInput {
  conglomerateId: string;
  prompt: string;
}

export interface CreateCompanyResult {
  companyId: string;
  slug: string;
  url: string;
}

export async function CreateCompany(input: CreateCompanyInput): Promise<CreateCompanyResult> {
  // 1. extract spec (mini tier, guided JSON; deterministic fallback offline)
  const spec = await act.extractSpec(input.prompt);

  // 2. control-DB rows first — everything else hangs off companyId
  const { companyId } = await act.upsertCompany({
    conglomerateId: input.conglomerateId,
    spec,
  });

  // 3. parallel provisioning (DB, repo, analytics, real mailbox, secret vault §6)
  const [, repo, umamiSiteId] = await Promise.all([
    act.provisionCompanyDb(spec.slug),
    act.createForgejoRepo(spec.slug),
    act.createUmamiSite(spec.slug, spec.name),
    act.provisionMailbox({ companyId, slug: spec.slug, name: spec.name }),
    act.provisionSecrets(companyId),
  ]);

  await act.recordProvisioning({ companyId, repo, umamiSiteId });

  // 4. fast-path first deploy (no agent)
  const { url } = await act.deployLanding({ companyId, spec, umamiSiteId });

  // 5. seed tasks + schedule the daily heartbeat (§6 step 4) + ledger event
  await act.seedTasks({ companyId, spec });
  await act.scheduleHeartbeat(companyId);
  await act.appendLedger({
    companyId,
    actor: "system",
    eventType: "company_created",
    payload: { slug: spec.slug, name: spec.name, mission: spec.mission, url },
  });

  return { companyId, slug: spec.slug, url };
}
