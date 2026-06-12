#!/usr/bin/env bun
/**
 * Build the `opencorp-agentd` E2B template from infra/e2b/e2b.Dockerfile
 * (build system v2 — the Dockerfile is parsed and built in E2B's cloud; no
 * local Docker needed).
 *
 *   bun services/sandboxd/scripts/build-template.ts
 *
 * Needs E2B auth (`bunx @e2b/cli auth login`, or E2B_ACCESS_TOKEN). Rebuild only
 * when system deps change — agentd is uploaded at claim time, not baked in.
 */
import { Template, defaultBuildLogger } from "e2b";

const dockerfile = new URL("../../../infra/e2b/e2b.Dockerfile", import.meta.url).pathname;

const info = await Template.build(Template().fromDockerfile(dockerfile), "opencorp-agentd", {
  cpuCount: 2, // §5.3 worker budget: 2 vCPU / 4 GB
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
});

console.log(`\ntemplate ready: ${info.templateId} (alias: opencorp-agentd)`);
