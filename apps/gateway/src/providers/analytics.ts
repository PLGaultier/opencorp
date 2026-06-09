import type { SecretStore } from "../secrets";

/**
 * Analytics arm (§7.1 analytics-mcp, §3 Umami). Read-only. Backed by the Umami
 * stats API when a company has a site id and a `UMAMI_API_TOKEN` secret;
 * otherwise returns a zeroed structure so the tool is always callable in dev.
 */
export interface AnalyticsStats {
  source: "umami" | "none";
  pageviews: number;
  visitors: number;
  range: string;
}

export interface AnalyticsQuery {
  siteId: string | null;
  rangeDays: number;
}

export async function getAnalytics(
  companyId: string,
  secrets: SecretStore,
  q: AnalyticsQuery,
): Promise<AnalyticsStats> {
  const base = process.env.UMAMI_API_URL;
  const token = await secrets.get(companyId, "UMAMI_API_TOKEN");
  const range = `${q.rangeDays}d`;
  if (!base || !token || !q.siteId) {
    return { source: "none", pageviews: 0, visitors: 0, range };
  }
  const endAt = Date.now();
  const startAt = endAt - q.rangeDays * 86_400_000;
  const res = await fetch(
    `${base}/api/websites/${q.siteId}/stats?startAt=${startAt}&endAt=${endAt}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`umami stats failed: ${res.status}`);
  const data = (await res.json()) as { pageviews?: { value: number }; visitors?: { value: number } };
  return {
    source: "umami",
    pageviews: data.pageviews?.value ?? 0,
    visitors: data.visitors?.value ?? 0,
    range,
  };
}
