/**
 * Sliding-window limiter (§7.2). In-memory implementation — correct for a
 * single gateway instance (dev/M2); the Valkey implementation replaces the
 * store when the gateway scales out. Failed calls count: record() runs
 * before the tool executes.
 */

export interface ToolLimits {
  hour?: number;
  day?: number;
}

// §7.2 defaults copied from NanoCorp's published table (write tools only)
export const DEFAULT_LIMITS: Record<string, ToolLimits> = {
  send_email: { hour: 20, day: 100 },
  reply_email: { hour: 20, day: 100 },
  create_product: { hour: 10, day: 50 },
  delete_product: { hour: 5, day: 20 },
  set_custom_domain: { hour: 2, day: 5 },
  submit_form: { hour: 10, day: 50 },
  // ads-mcp (§14): money-out tools kept tight so a loop can't thrash budgets.
  create_campaign: { hour: 5, day: 20 },
  set_budget: { hour: 5, day: 20 },
  launch_campaign: { hour: 5, day: 20 },
  pause_campaign: { hour: 20, day: 100 },
  create_document: { hour: 30, day: 200 },
  update_document: { hour: 30, day: 200 },
  set_env_vars: { hour: 30, day: 150 },
  search_prospects: { hour: 20, day: 100 },
  verify_email: { hour: 5, day: 50 },
  deploy_site: { hour: 30, day: 100 },
  execute_sql: { hour: 60, day: 500 },
  update_mission: { hour: 2, day: 5 },
  create_task: { hour: 20, day: 60 },
  update_task: { hour: 30, day: 100 },
  // code-mcp (§7.1): generous — coding is iterative — but bounded so a runaway
  // loop can't hammer the sandbox indefinitely (the task budgets cap it too).
  exec: { hour: 200, day: 1000 },
  write_file: { hour: 200, day: 1000 },
  git_commit_push: { hour: 30, day: 150 },
};

export interface RateLimitError {
  error: "rate_limited";
  tool: string;
  window: "hour" | "day";
  used: number;
  limit: number;
  retry_after_s: number;
  should_wait: boolean;
  message: string;
}

const WINDOWS: { name: "hour" | "day"; ms: number }[] = [
  { name: "hour", ms: 3_600_000 },
  { name: "day", ms: 86_400_000 },
];

export class MemoryRateLimiter {
  private calls = new Map<string, number[]>();

  /** Records the call and returns an error if any window is exceeded. */
  check(companyId: string, tool: string, limits = DEFAULT_LIMITS): RateLimitError | null {
    const cfg = limits[tool];
    const key = `${companyId}:${tool}`;
    const now = Date.now();
    const dayAgo = now - 86_400_000;
    const stamps = (this.calls.get(key) ?? []).filter((t) => t > dayAgo);
    stamps.push(now); // failed calls still count
    this.calls.set(key, stamps);
    if (!cfg) return null;

    for (const w of WINDOWS) {
      const limit = cfg[w.name];
      if (!limit) continue;
      const inWindow = stamps.filter((t) => t > now - w.ms);
      if (inWindow.length > limit) {
        const oldest = inWindow[0]!;
        const retryAfterS = Math.ceil((oldest + w.ms - now) / 1000);
        return {
          error: "rate_limited",
          tool,
          window: w.name,
          used: inWindow.length,
          limit,
          retry_after_s: retryAfterS,
          should_wait: retryAfterS <= 300,
          message: `Rate limit hit for ${tool} (${inWindow.length}/${limit}). Resets in ~${Math.ceil(retryAfterS / 60)} min. ${retryAfterS <= 300 ? "Wait and retry." : "Do not wait; move on and retry on a future run."}`,
        };
      }
    }
    return null;
  }
}
