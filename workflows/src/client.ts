import { Client, Connection } from "@temporalio/client";
import type { CreateCompanyInput, CreateCompanyResult } from "./workflows";

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

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
