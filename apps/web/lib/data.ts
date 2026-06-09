/**
 * Data layer for the dashboard. When NEXT_PUBLIC_API_URL is set it fetches
 * the real OpenCorp API; otherwise it serves demo data mirroring the two
 * companies created during M1 validation, so the Vercel preview stands alone.
 */

export interface Company {
  id: string;
  slug: string;
  name: string;
  mission: string;
  status: "active" | "paused";
  creditsSpent: number;
  revenueCents: number;
  tasksDone: number;
  tasksQueued: number;
  url: string;
}

export interface LedgerEvent {
  seq: number;
  companySlug: string | null;
  actor: string;
  eventType: string;
  summary: string;
  hash: string;
  createdAt: string;
}

export interface CompanyTask {
  title: string;
  status: "pending" | "queued" | "running" | "failed" | "done";
  priority: number;
}

export const demoCompanies: Company[] = [
  {
    id: "e4e62166-f974-44fe-842e-8f38e2610832",
    slug: "sell-handmade-ceramic",
    name: "Sell Handmade Ceramic",
    mission: "Build and grow a business around: sell handmade ceramic mugs online to coffee lovers",
    status: "active",
    creditsSpent: 2.4,
    revenueCents: 5800,
    tasksDone: 4,
    tasksQueued: 3,
    url: "http://sell-handmade-ceramic.localhost",
  },
  {
    id: "b220b359-37fa-4877-b217-7b20c83289b2",
    slug: "a-newsletter-about",
    name: "A Newsletter About",
    mission: "Build and grow a business around: a newsletter about vintage synthesizers for collectors",
    status: "active",
    creditsSpent: 1.1,
    revenueCents: 2900,
    tasksDone: 2,
    tasksQueued: 3,
    url: "http://a-newsletter-about.localhost",
  },
];

export const demoTasks: Record<string, CompanyTask[]> = {
  "sell-handmade-ceramic": [
    { title: "Define the offer", status: "done", priority: 2 },
    { title: "Improve the landing page", status: "done", priority: 1 },
    { title: "Identify first 10 prospects", status: "running", priority: 0 },
    { title: "Set up payment link for first product", status: "queued", priority: 2 },
    { title: "Write outreach email draft", status: "queued", priority: 1 },
  ],
  "a-newsletter-about": [
    { title: "Define the offer", status: "done", priority: 2 },
    { title: "Improve the landing page", status: "running", priority: 1 },
    { title: "Identify first 10 prospects", status: "queued", priority: 0 },
  ],
};

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

export const demoLedger: LedgerEvent[] = [
  { seq: 14, companySlug: "sell-handmade-ceramic", actor: "worker:t-7", eventType: "tool_call", summary: "search_prospects(\"independent coffee shops, Paris\")", hash: "9f2c41ab8e01", createdAt: ago(2) },
  { seq: 13, companySlug: "sell-handmade-ceramic", actor: "worker:t-7", eventType: "llm_call", summary: "standard tier · 1,842 tokens · €0.0031", hash: "77ab90c1d2f3", createdAt: ago(3) },
  { seq: 12, companySlug: "a-newsletter-about", actor: "worker:t-4", eventType: "deploy", summary: "deploy_site → a-newsletter-about.localhost (v2)", hash: "c01dd24e9a55", createdAt: ago(11) },
  { seq: 11, companySlug: "sell-handmade-ceramic", actor: "system", eventType: "money_in", summary: "Payment received: €29.00 (Handmade mug, classic)", hash: "31e8f00b6c77", createdAt: ago(26) },
  { seq: 10, companySlug: "sell-handmade-ceramic", actor: "ceo", eventType: "task_state", summary: "Task \"Improve the landing page\" → done", hash: "ab44c19e0d12", createdAt: ago(41) },
  { seq: 9, companySlug: "a-newsletter-about", actor: "ceo", eventType: "credit_change", summary: "task_charge −1.0 credit (estimated)", hash: "5d6e7f8a9b0c", createdAt: ago(58) },
  { seq: 8, companySlug: "sell-handmade-ceramic", actor: "worker:t-5", eventType: "email_sent", summary: "send_email → email:a1b2c3d4e5f6 (outreach #3)", hash: "e2d3c4b5a697", createdAt: ago(75) },
  { seq: 7, companySlug: "a-newsletter-about", actor: "system", eventType: "credit_change", summary: "task_refund +1.0 credit (task failed, auto-refund)", hash: "0192a3b4c5d6", createdAt: ago(90) },
  { seq: 2, companySlug: "sell-handmade-ceramic", actor: "system", eventType: "company_created", summary: "Company created from one prompt → live in 0.3 s", hash: "f00dbeef1234", createdAt: ago(240) },
  { seq: 1, companySlug: "a-newsletter-about", actor: "system", eventType: "company_created", summary: "Company created from one prompt → live in 0.3 s", hash: "deadbeef0001", createdAt: ago(300) },
];

export const isDemo = !process.env.NEXT_PUBLIC_API_URL;

export async function getCompanies(): Promise<Company[]> {
  return demoCompanies; // swapped for API fetch once the control plane is hosted
}

export async function getLedger(): Promise<LedgerEvent[]> {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (!api) return demoLedger;
  try {
    const res = await fetch(`${api}/api/ledger?limit=50`, { next: { revalidate: 5 } });
    const { events } = (await res.json()) as { events: { seq: number; companyId: string | null; actor: string; eventType: string; payload: unknown; hash: string; createdAt: string }[] };
    return events
      .map((e) => ({
        seq: e.seq,
        companySlug: e.companyId,
        actor: e.actor,
        eventType: e.eventType,
        summary: JSON.stringify(e.payload).slice(0, 120),
        hash: e.hash.slice(0, 12),
        createdAt: e.createdAt,
      }))
      .reverse();
  } catch {
    return demoLedger;
  }
}
