import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Browser arm (§7.1 browser-mcp, §8 egress). Real interactive browsing via a
 * headless Chromium (Playwright), with per-task page sessions so an agent can
 * navigate → type → click → submit → extract/screenshot across tool calls.
 *
 * Selection is lazy and degrading: with Playwright + a Chromium binary present
 * we drive a real browser; otherwise we fall back to fetch-based navigate/extract
 * (no JS, stateless) and the interactive tools return a clear "install Playwright"
 * error instead of hanging. Same egress discipline as the sandbox: only http(s),
 * never private/metadata addresses.
 */

export interface NavResult {
  url: string;
  status: number;
  title: string | null;
  text: string;
}
export interface ExtractResult {
  url: string;
  title: string | null;
  text: string;
}
export type ActResult =
  | { ok: true; url: string; title: string | null }
  | { ok: false; error: string; message: string };
export type ShotResult =
  | { ok: true; path: string; width: number; height: number }
  | { ok: false; error: string; message: string };

export interface BrowserProvider {
  navigate(taskId: string, url: string): Promise<NavResult>;
  extract(taskId: string, url?: string): Promise<ExtractResult | { ok: false; error: string; message: string }>;
  click(taskId: string, selector: string): Promise<ActResult>;
  type(taskId: string, selector: string, text: string): Promise<ActResult>;
  submitForm(taskId: string, selector?: string): Promise<ActResult>;
  screenshot(taskId: string): Promise<ShotResult>;
  closeSession(taskId: string): Promise<void>;
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

const INSTALL_HINT =
  "Interactive browsing needs Playwright: `bun add playwright && bunx playwright install chromium`, then set BROWSER_KIND=playwright.";

// ── Fetch fallback (no JS, stateless) ──────────────────────────────────────
export class FetchBrowser implements BrowserProvider {
  async navigate(_taskId: string, url: string): Promise<NavResult> {
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
  async extract(taskId: string, url?: string) {
    if (!url) return { ok: false as const, error: "not_supported", message: INSTALL_HINT };
    const { url: u, title, text } = await this.navigate(taskId, url);
    return { url: u, title, text };
  }
  async click(): Promise<ActResult> {
    return { ok: false, error: "not_supported", message: INSTALL_HINT };
  }
  async type(): Promise<ActResult> {
    return { ok: false, error: "not_supported", message: INSTALL_HINT };
  }
  async submitForm(): Promise<ActResult> {
    return { ok: false, error: "not_supported", message: INSTALL_HINT };
  }
  async screenshot(): Promise<ShotResult> {
    return { ok: false, error: "not_supported", message: INSTALL_HINT };
  }
  async closeSession(): Promise<void> {
    /* stateless */
  }
}

// ── Minimal Playwright surface (typed locally so the package is optional) ───
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number } | null>;
  title(): Promise<string>;
  url(): string;
  click(sel: string, opts?: { timeout?: number }): Promise<void>;
  fill(sel: string, val: string, opts?: { timeout?: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  waitForLoadState(state?: string, opts?: { timeout?: number }): Promise<void>;
  evaluate(expr: string): Promise<string>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  viewportSize(): { width: number; height: number } | null;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts?: { userAgent?: string }): Promise<PwContext>;
}
interface PwChromium {
  launch(opts?: { headless?: boolean; args?: string[] }): Promise<PwBrowser>;
}

// ── Real browser (Playwright/Chromium) with per-task sessions ───────────────
export class PlaywrightBrowser implements BrowserProvider {
  private fallback = new FetchBrowser();
  private chromium: PwChromium | null = null;
  private pwBrowser: PwBrowser | null = null;
  private initPromise?: Promise<void>;
  private degraded = false;
  private sessions = new Map<string, { context: PwContext; page: PwPage; lastUsed: number }>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    private shotsDir = process.env.BROWSER_SHOTS_DIR ?? join(tmpdir(), "opencorp-shots"),
    private maxSessions = Number(process.env.BROWSER_MAX_SESSIONS ?? 8),
    private idleMs = 5 * 60_000,
  ) {}

  /** Lazily import + launch Chromium once; degrade to fetch on any failure. */
  private async ready(): Promise<boolean> {
    if (this.degraded) return false;
    if (this.pwBrowser) return true;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          // Variable specifier: keeps `playwright` an optional runtime dep (TS
          // won't try to resolve it at build time when it isn't installed).
          const mod = "playwright";
          const pw = (await import(mod)) as unknown as { chromium: PwChromium };
          this.chromium = pw.chromium;
          // --no-sandbox / --disable-dev-shm-usage: required to launch headless
          // Chromium as root inside a container (harmless locally).
          this.pwBrowser = await this.chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
          });
          this.sweeper = setInterval(() => void this.sweep(), 60_000);
        } catch {
          this.degraded = true; // pkg or chromium binary missing
        }
      })();
    }
    await this.initPromise;
    return !this.degraded && !!this.pwBrowser;
  }

  private async session(taskId: string) {
    const existing = this.sessions.get(taskId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) await this.closeSession(oldest[0]);
    }
    const context = await this.pwBrowser!.newContext({ userAgent: "OpenCorpBot/0.1 (+https://opencorp.app)" });
    const page = await context.newPage();
    const s = { context, page, lastUsed: Date.now() };
    this.sessions.set(taskId, s);
    return s;
  }

  private async pageText(page: PwPage): Promise<string> {
    try {
      const t = await page.evaluate("document.body ? document.body.innerText : ''");
      return t.replace(/\s+/g, " ").trim().slice(0, 8000);
    } catch {
      return "";
    }
  }

  async navigate(taskId: string, url: string): Promise<NavResult> {
    if (!(await this.ready())) return this.fallback.navigate(taskId, url);
    const u = assertPublicUrl(url);
    const { page } = await this.session(taskId);
    const res = await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    return { url: page.url(), status: res?.status() ?? 0, title: await page.title(), text: await this.pageText(page) };
  }

  async extract(taskId: string, url?: string) {
    if (!(await this.ready())) return this.fallback.extract(taskId, url);
    const { page } = await this.session(taskId);
    if (url) await page.goto(assertPublicUrl(url).toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    return { url: page.url(), title: await page.title(), text: await this.pageText(page) };
  }

  async click(taskId: string, selector: string): Promise<ActResult> {
    if (!(await this.ready())) return { ok: false, error: "browser_unavailable", message: INSTALL_HINT };
    const { page } = await this.session(taskId);
    try {
      await page.click(selector, { timeout: 10_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      return { ok: true, url: page.url(), title: await page.title() };
    } catch (e) {
      return { ok: false, error: "click_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async type(taskId: string, selector: string, text: string): Promise<ActResult> {
    if (!(await this.ready())) return { ok: false, error: "browser_unavailable", message: INSTALL_HINT };
    const { page } = await this.session(taskId);
    try {
      await page.fill(selector, text, { timeout: 10_000 });
      return { ok: true, url: page.url(), title: await page.title() };
    } catch (e) {
      return { ok: false, error: "type_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async submitForm(taskId: string, selector?: string): Promise<ActResult> {
    if (!(await this.ready())) return { ok: false, error: "browser_unavailable", message: INSTALL_HINT };
    const { page } = await this.session(taskId);
    try {
      if (selector) await page.click(selector, { timeout: 10_000 });
      else await page.keyboard.press("Enter");
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      return { ok: true, url: page.url(), title: await page.title() };
    } catch (e) {
      return { ok: false, error: "submit_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async screenshot(taskId: string): Promise<ShotResult> {
    if (!(await this.ready())) return { ok: false, error: "browser_unavailable", message: INSTALL_HINT };
    const { page } = await this.session(taskId);
    try {
      mkdirSync(this.shotsDir, { recursive: true });
      const path = join(this.shotsDir, `${taskId}-${Date.now()}.png`);
      writeFileSync(path, await page.screenshot({ fullPage: false }));
      const vp = page.viewportSize() ?? { width: 0, height: 0 };
      return { ok: true, path, width: vp.width, height: vp.height };
    } catch (e) {
      return { ok: false, error: "screenshot_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async closeSession(taskId: string): Promise<void> {
    const s = this.sessions.get(taskId);
    if (s) {
      this.sessions.delete(taskId);
      await s.context.close().catch(() => {});
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastUsed > this.idleMs) await this.closeSession(id);
  }
}

/** Pick a browser: fetch-only when BROWSER_KIND=fetch, else lazy Playwright. */
export function makeBrowser(): BrowserProvider {
  return (process.env.BROWSER_KIND ?? "auto") === "fetch" ? new FetchBrowser() : new PlaywrightBrowser();
}
