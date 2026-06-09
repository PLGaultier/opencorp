/**
 * Browser arm (§7.1 browser-mcp, §8 egress). The Playwright/browser-use fleet
 * lands with the execution plane (M4); in M2/M3 the gateway offers the two
 * tools a worker needs to research the open web — navigate + extract — backed
 * by plain fetch, with the same egress discipline the sandbox proxy will
 * enforce: only http(s), and never private/metadata addresses. Interactive
 * tools (click/type/screenshot/submit_form) return `not_supported` until the
 * real fleet is wired, so an agent degrades instead of hanging.
 */
export interface BrowserProvider {
  navigate(url: string): Promise<{ url: string; status: number; title: string | null; text: string }>;
}

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|fc00:|fd00:|172\.(1[6-9]|2\d|3[01])\.)/i;

/** Egress guard (§8): block non-http(s) and RFC1918 / link-local / metadata. */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("blocked_scheme");
  if (PRIVATE_HOST.test(u.hostname) || u.hostname === "metadata.google.internal")
    throw new Error("blocked_private_address");
  return u;
}

/** Strip a fetched HTML document to readable text + title (pure, unit-tested). */
export function extractText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
  return { title, text };
}

export class FetchBrowser implements BrowserProvider {
  async navigate(url: string) {
    const u = assertPublicUrl(url);
    const res = await fetch(u, {
      headers: { "user-agent": "OpenCorpBot/0.1 (+https://opencorp.app)" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    const { title, text } = extractText(html);
    return { url: u.toString(), status: res.status, title, text };
  }
}
