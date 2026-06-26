import type { Sql } from "postgres";

/**
 * Sliding-window limiter (§7.2). Two stores behind one contract:
 *   - MemoryRateLimiter  in-process; correct for a single instance (tests/dev).
 *   - PgRateLimiter      Postgres-backed; durable across gateway restarts and
 *                        shared across instances, with no extra dependency
 *                        (Valkey would scale further but the local MVP keeps to
 *                        Postgres + Temporal). This is what the gateway uses.
 * Failed calls count: the call is recorded before the tool executes.
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

/** One contract, two stores — so the gateway can swap memory↔Postgres. */
export interface RateLimiter {
  check(companyId: string, tool: string): RateLimitError | null | Promise<RateLimitError | null>;
}

/** Single source of truth for the error payload, shared by both stores. */
function rateLimitError(
  tool: string,
  window: "hour" | "day",
  used: number,
  limit: number,
  oldestMs: number,
): RateLimitError {
  const winMs = window === "hour" ? 3_600_000 : 86_400_000;
  const retryAfterS = Math.max(1, Math.ceil((oldestMs + winMs - Date.now()) / 1000));
  return {
    error: "rate_limited",
    tool,
    window,
    used,
    limit,
    retry_after_s: retryAfterS,
    should_wait: retryAfterS <= 300,
    message: `Rate limit hit for ${tool} (${used}/${limit}). Resets in ~${Math.ceil(retryAfterS / 60)} min. ${retryAfterS <= 300 ? "Wait and retry." : "Do not wait; move on and retry on a future run."}`,
  };
}

export class MemoryRateLimiter implements RateLimiter {
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
        return rateLimitError(tool, w.name, inWindow.length, limit, inWindow[0]!);
      }
    }
    return null;
  }
}

/**
 * Postgres-backed limiter (§7.2). One row per recorded call in `rate_limit_hits`;
 * windows are counted with timestamp filters so the count survives restarts and
 * is consistent across gateway instances. The just-recorded call is included
 * (it's inserted before the count). Rows past the widest window are pruned
 * opportunistically so storage stays bounded without a separate cron.
 */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private sql: Sql,
    private limits = DEFAULT_LIMITS,
  ) {}

  async check(companyId: string, tool: string): Promise<RateLimitError | null> {
    const cfg = this.limits[tool];
    if (!cfg) return null; // only limited tools touch the DB

    await this.sql`INSERT INTO rate_limit_hits (company_id, tool) VALUES (${companyId}, ${tool})`;
    if (Math.random() < 0.05) {
      await this.sql`
        DELETE FROM rate_limit_hits
        WHERE company_id = ${companyId} AND tool = ${tool}
          AND created_at < now() - interval '24 hours'`;
    }

    const [r] = await this.sql<
      { hour_n: string; hour_oldest: Date | null; day_n: string; day_oldest: Date | null }[]
    >`
      SELECT
        count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour_n,
        min(created_at) FILTER (WHERE created_at > now() - interval '1 hour') AS hour_oldest,
        count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS day_n,
        min(created_at) FILTER (WHERE created_at > now() - interval '24 hours') AS day_oldest
      FROM rate_limit_hits WHERE company_id = ${companyId} AND tool = ${tool}`;

    const hourN = Number(r!.hour_n);
    const dayN = Number(r!.day_n);
    if (cfg.hour && hourN > cfg.hour && r!.hour_oldest) {
      return rateLimitError(tool, "hour", hourN, cfg.hour, r!.hour_oldest.getTime());
    }
    if (cfg.day && dayN > cfg.day && r!.day_oldest) {
      return rateLimitError(tool, "day", dayN, cfg.day, r!.day_oldest.getTime());
    }
    return null;
  }
}
