import { cookies } from "next/headers";
import { API_URL, AUTH_DISABLED } from "./data";

/**
 * Server-side ownership for the public company pages (§4). A logged-out visitor
 * sees only the P&L stats + the public hash-chained ledger; the owner (a member
 * of the company's conglomerate) sees the full operational dashboard. The owner
 * signal comes from the API, which is the real enforcement point — these
 * helpers only decide what the page bothers to fetch and render.
 *
 * Importing `next/headers` makes this module server-only: it must never be
 * imported from a Client Component (data.ts stays client-safe for that reason).
 */

/** The raw Cookie header to forward to the API for owner-scoped fetches. */
export async function forwardCookie(): Promise<string> {
  return (await cookies()).toString();
}

/** Does the current viewer own (can manage) this company? */
export async function isOwner(slug: string): Promise<boolean> {
  if (AUTH_DISABLED) return true; // single local dev owner sees everything
  if (!API_URL) return false; // demo / preview build: no session → public view
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/access`, {
      headers: { cookie: await forwardCookie() },
      cache: "no-store",
    });
    if (!res.ok) return false;
    return Boolean(((await res.json()) as { owner?: boolean }).owner);
  } catch {
    return false;
  }
}
