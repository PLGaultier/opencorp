import { Worker, NativeConnection } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import * as createActivities from "./activities";
import * as taskActivities from "./taskActivities";
import * as withdrawalActivities from "./withdrawalActivities";

const activities = { ...createActivities, ...taskActivities, ...withdrawalActivities };

/**
 * Temporal worker for the control-plane task queue. Run with Node (tsx) —
 * the Temporal worker uses a native Rust core that Bun does not support yet.
 */
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
export const TASK_QUEUE = "opencorp-control";

const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
const worker = await Worker.create({
  connection,
  taskQueue: TASK_QUEUE,
  workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
  activities,
});

console.log(`temporal worker on ${TEMPORAL_ADDRESS}, queue ${TASK_QUEUE}`);
await worker.run();
