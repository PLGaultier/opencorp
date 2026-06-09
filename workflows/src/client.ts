import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import type { CreateCompanyInput, CreateCompanyResult } from "./workflows";
import type { WithdrawalResult } from "./withdrawalActivities";

const TASK_QUEUE = "opencorp-control";

let client: Client | null = null;

export async function temporalClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    });
    client = new Client({ connection });
  }
  return client;
}

/** Workflow ID `create-company:{conglomerate}:{hash(prompt)}` dedupes retries of the same prompt. */
export async function startCreateCompany(
  input: CreateCompanyInput,
): Promise<CreateCompanyResult> {
  const c = await temporalClient();
  const promptKey = String(simpleHash(input.prompt));
  const handle = await c.workflow.start("CreateCompany", {
    taskQueue: TASK_QUEUE,
    workflowId: `create-company:${input.conglomerateId}:${promptKey}`,
    args: [input],
  });
  return handle.result() as Promise<CreateCompanyResult>;
}

/** Manual heartbeat trigger (dashboard "Run now"); cron schedules call the same workflow. */
export async function startHeartbeat(companyId: string): Promise<unknown> {
  const c = await temporalClient();
  const handle = await c.workflow.start("CompanyHeartbeat", {
    taskQueue: TASK_QUEUE,
    workflowId: `heartbeat:${companyId}:${Date.now()}`,
    args: [{ companyId }],
  });
  return handle.result();
}

/** Manual Run (§5.2 cap semantics): bypasses caps, still requires credits. */
export async function startTaskRun(taskId: string): Promise<unknown> {
  const c = await temporalClient();
  const handle = await c.workflow.start("TaskRun", {
    taskQueue: TASK_QUEUE,
    workflowId: `task-run:${taskId}`,
    args: [{ taskId }],
  });
  return handle.result();
}

/** Money-out (§10). withdrawalId is minted here so the API can return it and
 *  the workflow stays deterministic; workflowId dedupes accidental double-clicks. */
export async function startWithdrawal(input: {
  companyId: string;
  amountCents: number;
  currency?: string;
}): Promise<{ withdrawalId: string } & WithdrawalResult> {
  const c = await temporalClient();
  const withdrawalId = randomUUID();
  const args = { withdrawalId, companyId: input.companyId, amountCents: input.amountCents, currency: input.currency ?? "eur" };
  const handle = await c.workflow.start("Withdrawal", {
    taskQueue: TASK_QUEUE,
    workflowId: `withdrawal:${withdrawalId}`,
    args: [args],
  });
  const result = (await handle.result()) as WithdrawalResult;
  return { withdrawalId, ...result };
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
