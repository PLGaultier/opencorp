/**
 * Data layer for the dashboard. When NEXT_PUBLIC_API_URL is set it fetches the
 * real OpenCorp API (public companies + P&L + ledger); otherwise it serves demo
 * data so the Vercel preview stands alone. P&L mirrors §9.4: revenue in, credits
 * spent, money withdrawn, current balance — every number on the public ledger.
 */

/** The CEO "brains" ladder (§10): cheaper → pricier model bundle. */
export type ModelLevel = "intern" | "grad" | "phd";

export interface Company {
  id: string;
  slug: string;
  name: string;
  mission: string;
  status: "active" | "paused";
  /** The CEO "brains" level — which model bundle powers the agents (§10). */
  modelLevel: ModelLevel;
  /** Real money spent on operations (LLM/API cost), in cents — §10 pillar 1. */
  spendCents: number;
  revenueCents: number;
  moneyOutCents: number;
  balanceCents: number;
  tasksDone: number;
  tasksQueued: number;
  dailyTaskCap: number;
  autonomyLevel: "supervised" | "bounded" | "full";
  isPublic: boolean;
  adMonthlyBudgetCapCents: number;
  emailAddress?: string | null;
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
  /** Langfuse public trace for the task's full LLM transcript (§9.2). */
  traceUrl?: string | null;
}

/** Full task row for the task management UI (list + detail). */
export interface TaskDetail {
  id: string;
  title: string;
  description: string;
  status: "pending" | "queued" | "running" | "failed" | "done";
  priority: number;
  resultSummary: string | null;
  error: string | null;
  creditsEstimated: number | null;
  creditsCharged: number | null;
  traceUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Agent on the org chart: the CEO, a department head, or a worker. */
export interface Agent {
  id: string;
  kind: "ceo" | "department" | "worker";
  name: string;
  rolePrompt: string;
  modelTier: string;
}

/** A department head's advice from a heartbeat (department_plan ledger event). */
export interface DepartmentPlan {
  seq: number;
  actor: string;
  payload: { headline?: string; proposedTasks?: string[] };
  createdAt: string;
}

/** A product the CEO created (catalogue entry). */
export interface Product {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  paymentLink: string;
}

/** A completed payment recorded against a product. */
export interface Payment {
  id: string;
  productId: string | null;
  productName: string | null;
  amountCents: number;
  currency: string;
  feeCents: number;
  netCents: number;
  createdAt: string;
}

/** An ad campaign with this-month spend, attributed revenue and ROAS (§14). */
export interface Campaign {
  id: string;
  name: string;
  objective: string;
  status: "paused" | "active" | "archived";
  budgetCents: number;
  budgetType: string;
  spendCents: number;
  revenueCents: number;
  roas: number | null;
}

export interface RevenueSummary {
  grossCents: number;
  feesCents: number;
  netCents: number;
  count: number;
}

/** An email in the company's Stalwart mailbox (inbound or outbound). */
export interface Email {
  id: string;
  direction: "in" | "out";
  fromAddr: string;
  toAddrs: string[];
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  read: boolean;
  createdAt: string;
}

/** Privacy-light website analytics for a company site (last 30 days). */
export interface SiteAnalytics {
  pageviews: number;
  visitors: number;
  sessions: number;
  peakPerDay: number;
}

/** Raw ledger event for the company terminal — full (redacted) payload. */
export interface TerminalEvent {
  seq: number;
  actor: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
export const isDemo = !API_URL;

/** Local MVP frictionless mode (API injects a single dev owner). */
export const AUTH_DISABLED = process.env.NEXT_PUBLIC_AUTH_DISABLED === "1";
/** Whether the GitHub social-login button should be shown. */
export const GITHUB_ENABLED = process.env.NEXT_PUBLIC_AUTH_GITHUB === "1";
/** Base URL where deployd serves published company sites (path-based, local). */
const DEPLOYD_URL = process.env.NEXT_PUBLIC_DEPLOYD_URL ?? "";

/** Public URL of a company's website — local deployd path, else prod subdomain. */
export function siteUrl(slug: string): string {
  return DEPLOYD_URL ? `${DEPLOYD_URL.replace(/\/$/, "")}/sites/${slug}/` : `http://${slug}.opencorp.app`;
}

export const demoCompanies: Company[] = [
  {
    id: "e4e62166-f974-44fe-842e-8f38e2610832",
    slug: "sell-handmade-ceramic",
    name: "Sell Handmade Ceramic",
    mission: "Build and grow a business around: sell handmade ceramic mugs online to coffee lovers",
    status: "active",
    modelLevel: "grad",
    spendCents: 240,
    revenueCents: 5800,
    moneyOutCents: 2900,
    balanceCents: 2900,
    tasksDone: 4,
    tasksQueued: 3,
    dailyTaskCap: 3,
    autonomyLevel: "supervised",
    isPublic: true,
    adMonthlyBudgetCapCents: 0,
  },
  {
    id: "b220b359-37fa-4877-b217-7b20c83289b2",
    slug: "a-newsletter-about",
    name: "A Newsletter About",
    mission: "Build and grow a business around: a newsletter about vintage synthesizers for collectors",
    status: "active",
    modelLevel: "intern",
    spendCents: 110,
    revenueCents: 2900,
    moneyOutCents: 0,
    balanceCents: 2900,
    tasksDone: 2,
    tasksQueued: 3,
    dailyTaskCap: 3,
    autonomyLevel: "supervised",
    isPublic: true,
    adMonthlyBudgetCapCents: 0,
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

// Demo task details mirror demoTasks above with the full fields the task
// detail page renders (description, result, error, credits, timestamps).
export const demoTaskDetails: Record<string, TaskDetail[]> = {
  "sell-handmade-ceramic": [
    { id: "d1", title: "Define the offer", description: "Decide the first product line, price point and positioning for handmade ceramic mugs.", status: "done", priority: 2, resultSummary: "Offer defined: classic 350ml mug at €29, small-batch positioning for coffee lovers.", error: null, creditsEstimated: 1, creditsCharged: 1, traceUrl: null, createdAt: ago(240), startedAt: ago(235), finishedAt: ago(230) },
    { id: "d2", title: "Improve the landing page", description: "Tighten the hero copy and add the payment link above the fold.", status: "done", priority: 1, resultSummary: "Landing page v2 deployed with clearer hero and a buy button.", error: null, creditsEstimated: 1, creditsCharged: 1, traceUrl: null, createdAt: ago(200), startedAt: ago(60), finishedAt: ago(41) },
    { id: "d3", title: "Identify first 10 prospects", description: "Find independent coffee shops that might stock handmade mugs.", status: "running", priority: 0, resultSummary: null, error: null, creditsEstimated: 1, creditsCharged: null, traceUrl: null, createdAt: ago(120), startedAt: ago(3), finishedAt: null },
    { id: "d4", title: "Set up payment link for first product", description: "Create the product and a shareable payment link.", status: "queued", priority: 2, resultSummary: null, error: null, creditsEstimated: null, creditsCharged: null, traceUrl: null, createdAt: ago(100), startedAt: null, finishedAt: null },
    { id: "d5", title: "Write outreach email draft", description: "Draft the first outreach email for the prospect list.", status: "queued", priority: 1, resultSummary: null, error: null, creditsEstimated: null, creditsCharged: null, traceUrl: null, createdAt: ago(90), startedAt: null, finishedAt: null },
  ],
  "a-newsletter-about": [
    { id: "n1", title: "Define the offer", description: "Pick the newsletter's angle, cadence and subscription price.", status: "done", priority: 2, resultSummary: "Weekly deep-dive on one vintage synth, €5/month.", error: null, creditsEstimated: 1, creditsCharged: 1, traceUrl: null, createdAt: ago(290), startedAt: ago(285), finishedAt: ago(280) },
    { id: "n2", title: "Improve the landing page", description: "Add a sample issue and a subscribe form.", status: "running", priority: 1, resultSummary: null, error: null, creditsEstimated: 1, creditsCharged: null, traceUrl: null, createdAt: ago(60), startedAt: ago(11), finishedAt: null },
    { id: "n3", title: "Identify first 10 prospects", description: "Find synth collector communities to share the newsletter in.", status: "failed", priority: 0, resultSummary: null, error: "browser.navigate timed out after 3 retries (egress proxy unreachable)", creditsEstimated: 1, creditsCharged: 0, traceUrl: null, createdAt: ago(150), startedAt: ago(95), finishedAt: ago(90) },
  ],
};

// Demo org chart: CEO + the three M5 department heads + one ephemeral worker.
export const demoAgents: Record<string, Agent[]> = {
  "sell-handmade-ceramic": [
    { id: "a1", kind: "ceo", name: "CEO", rolePrompt: "You are the CEO of Sell Handmade Ceramic. Plan the day, delegate tasks to workers, and keep the company focused on revenue. You may queue tasks and patch the mission; you can never pause the company or change its caps.", modelTier: "standard" },
    { id: "a2", kind: "department", name: "CMO", rolePrompt: "You are the CMO. Each heartbeat, review analytics, outreach and revenue, then propose marketing tasks for the CEO to consider.", modelTier: "light" },
    { id: "a3", kind: "department", name: "CTO", rolePrompt: "You are the CTO. Each heartbeat, review the website, deploys and tooling, then propose technical tasks for the CEO to consider.", modelTier: "light" },
    { id: "a4", kind: "department", name: "CFO", rolePrompt: "You are the CFO. Each heartbeat, review the credit runway, revenue and spend, then propose financial priorities for the CEO to consider.", modelTier: "light" },
    { id: "a5", kind: "worker", name: "worker:t-42", rolePrompt: "Ephemeral worker sandbox executing one task with scoped MCP tool access.", modelTier: "standard" },
  ],
  "a-newsletter-about": [
    { id: "b1", kind: "ceo", name: "CEO", rolePrompt: "You are the CEO of A Newsletter About. Plan the day, delegate tasks to workers, and grow paid subscriptions.", modelTier: "standard" },
    { id: "b2", kind: "department", name: "CMO", rolePrompt: "You are the CMO. Propose growth tasks each heartbeat.", modelTier: "light" },
    { id: "b3", kind: "department", name: "CTO", rolePrompt: "You are the CTO. Propose technical tasks each heartbeat.", modelTier: "light" },
    { id: "b4", kind: "department", name: "CFO", rolePrompt: "You are the CFO. Propose financial priorities each heartbeat.", modelTier: "light" },
  ],
};

export const demoProducts: Record<string, Product[]> = {
  "sell-handmade-ceramic": [
    { id: "p1", name: "Handmade mug, classic", priceCents: 2900, currency: "eur", paymentLink: "#demo-payment-link" },
    { id: "p2", name: "Handmade mug, glazed (limited)", priceCents: 4500, currency: "eur", paymentLink: "#demo-payment-link" },
  ],
  "a-newsletter-about": [
    { id: "p3", name: "Newsletter subscription — monthly", priceCents: 500, currency: "eur", paymentLink: "#demo-payment-link" },
  ],
};

export const demoCampaigns: Record<string, Campaign[]> = {
  "sell-handmade-ceramic": [
    { id: "ac1", name: "Mugs — summer push", objective: "OUTCOME_SALES", status: "active", budgetCents: 3000, budgetType: "daily", spendCents: 1800, revenueCents: 5800, roas: 3.22 },
    { id: "ac2", name: "Mugs — broad awareness", objective: "OUTCOME_AWARENESS", status: "paused", budgetCents: 1000, budgetType: "daily", spendCents: 1600, revenueCents: 0, roas: 0 },
  ],
};

export const demoPayments: Record<string, { summary: RevenueSummary; payments: Payment[] }> = {
  "sell-handmade-ceramic": {
    summary: { grossCents: 5800, feesCents: 203, netCents: 5597, count: 2 },
    payments: [
      { id: "pay1", productId: "p1", productName: "Handmade mug, classic", amountCents: 2900, currency: "eur", feeCents: 101, netCents: 2799, createdAt: ago(26) },
      { id: "pay2", productId: "p1", productName: "Handmade mug, classic", amountCents: 2900, currency: "eur", feeCents: 102, netCents: 2798, createdAt: ago(120) },
    ],
  },
  "a-newsletter-about": {
    summary: { grossCents: 2900, feesCents: 102, netCents: 2798, count: 1 },
    payments: [
      { id: "pay3", productId: "p3", productName: "Newsletter subscription — monthly", amountCents: 500, currency: "eur", feeCents: 18, netCents: 482, createdAt: ago(60) },
      { id: "pay4", productId: "p3", productName: "Newsletter subscription — monthly", amountCents: 500, currency: "eur", feeCents: 18, netCents: 482, createdAt: ago(90) },
      { id: "pay5", productId: "p3", productName: "Newsletter subscription — monthly", amountCents: 500, currency: "eur", feeCents: 18, netCents: 482, createdAt: ago(150) },
      { id: "pay6", productId: "p3", productName: "Newsletter subscription — monthly", amountCents: 500, currency: "eur", feeCents: 18, netCents: 482, createdAt: ago(200) },
      { id: "pay7", productId: "p3", productName: "Newsletter subscription — monthly", amountCents: 500, currency: "eur", feeCents: 18, netCents: 482, createdAt: ago(250) },
      { id: "pay8", productId: "p3", productName: "Newsletter subscription — monthly", amountCents: 500, currency: "eur", feeCents: 18, netCents: 482, createdAt: ago(280) },
    ],
  },
};

export const demoEmails: Record<string, Email[]> = {
  "sell-handmade-ceramic": [
    { id: "em1", direction: "in", fromAddr: "marie@caffeine.fr", toAddrs: ["hello@sell-handmade-ceramic.opencorp.app"], subject: "Interested in your mugs!", bodyText: "Hi,\n\nI came across your ceramic mugs and I'm very interested in stocking them at our café in Lyon. We order in batches of 20–50 pieces. Do you offer wholesale pricing?\n\nBest,\nMarie", bodyHtml: null, read: true, createdAt: ago(30) },
    { id: "em2", direction: "out", fromAddr: "hello@sell-handmade-ceramic.opencorp.app", toAddrs: ["marie@caffeine.fr"], subject: "Re: Interested in your mugs!", bodyText: "Hi Marie,\n\nThank you for reaching out! We'd be happy to discuss wholesale pricing for Caffeine Lyon. For orders of 20+ we offer a 15% discount off our standard €29 retail price.\n\nWould you like to set up a call this week?\n\nBest,\nSell Handmade Ceramic", bodyHtml: null, read: true, createdAt: ago(28) },
    { id: "em3", direction: "in", fromAddr: "noreply@stripe.com", toAddrs: ["hello@sell-handmade-ceramic.opencorp.app"], subject: "Payment received: €29.00", bodyText: "A payment of €29.00 has been received for Handmade mug, classic.", bodyHtml: null, read: true, createdAt: ago(26) },
    { id: "em4", direction: "out", fromAddr: "hello@sell-handmade-ceramic.opencorp.app", toAddrs: ["luca@milan-coffee.it", "sofia@nordic-brew.se", "james@shoreditch-roast.co.uk"], subject: "Handmade ceramic mugs — introducing our first collection", bodyText: "Hello,\n\nWe're reaching out to introduce our handmade ceramic mugs to select independent coffee shops.\n\nOur classic 350ml mug is €29, small-batch, dishwasher safe.\n\nInterested in a sample?\n\nBest,\nSell Handmade Ceramic", bodyHtml: null, read: true, createdAt: ago(75) },
    { id: "em5", direction: "in", fromAddr: "james@shoreditch-roast.co.uk", toAddrs: ["hello@sell-handmade-ceramic.opencorp.app"], subject: "Re: Handmade ceramic mugs — introducing our first collection", bodyText: "Hey,\n\nThanks for the note. We're always on the lookout for quality ceramics. Can you send over a sample?\n\nCheers,\nJames", bodyHtml: null, read: false, createdAt: ago(10) },
  ],
  "a-newsletter-about": [
    { id: "en1", direction: "out", fromAddr: "hello@a-newsletter-about.opencorp.app", toAddrs: ["subscribers@list.a-newsletter-about.opencorp.app"], subject: "Issue #1: The Minimoog — how one synth changed everything", bodyText: "Welcome to the first issue of A Newsletter About.\n\nThis week: the Minimoog Model D, why it matters, and where to find one today.\n\n[Full issue in the browser version]", bodyHtml: null, read: true, createdAt: ago(180) },
    { id: "en2", direction: "in", fromAddr: "reader@synthforum.net", toAddrs: ["hello@a-newsletter-about.opencorp.app"], subject: "Love the newsletter — quick question", bodyText: "Hi,\n\nJust subscribed after seeing your Minimoog issue shared on the forums. Really nicely written.\n\nWill you be covering the ARP Odyssey at some point?\n\nThanks,\nDave", bodyHtml: null, read: false, createdAt: ago(20) },
  ],
};

export const demoDepartmentPlans: DepartmentPlan[] = [
  { seq: 103, actor: "dept:cfo", payload: { headline: "Critical: €5 credit runway with zero revenue requires immediate revenue focus.", proposedTasks: [] }, createdAt: ago(9) },
  { seq: 102, actor: "dept:cto", payload: { headline: "Day 1 post-launch: recommend diagnostics before scaling.", proposedTasks: ["Verify website is live and publicly accessible"] }, createdAt: ago(9) },
  { seq: 101, actor: "dept:cmo", payload: { headline: "Zero revenue and empty inbox signal need for foundational growth activation.", proposedTasks: ["Launch baseline customer outreach campaign"] }, createdAt: ago(9) },
];

export const demoLedger: LedgerEvent[] = [
  { seq: 16, companySlug: "sell-handmade-ceramic", actor: "user", eventType: "money_out", summary: "Withdrawal paid: €29.00 → connected account", hash: "a7c93f1102bd", createdAt: ago(1) },
  { seq: 15, companySlug: "sell-handmade-ceramic", actor: "worker:t-7", eventType: "tool_call", summary: "search_prospects(\"independent coffee shops, Paris\")", hash: "9f2c41ab8e01", createdAt: ago(2) },
  { seq: 14, companySlug: "sell-handmade-ceramic", actor: "worker:t-7", eventType: "llm_call", summary: "standard tier · 1,842 tokens · €0.0031", hash: "77ab90c1d2f3", createdAt: ago(3) },
  { seq: 13, companySlug: "a-newsletter-about", actor: "worker:t-4", eventType: "deploy", summary: "deploy_site → a-newsletter-about.opencorp.app (v2)", hash: "c01dd24e9a55", createdAt: ago(11) },
  { seq: 12, companySlug: "sell-handmade-ceramic", actor: "system", eventType: "money_in", summary: "Payment received: €29.00 (Handmade mug, classic)", hash: "31e8f00b6c77", createdAt: ago(26) },
  { seq: 11, companySlug: "sell-handmade-ceramic", actor: "ceo", eventType: "task_state", summary: "Task \"Improve the landing page\" → done", hash: "ab44c19e0d12", createdAt: ago(41) },
  { seq: 10, companySlug: "a-newsletter-about", actor: "ceo", eventType: "credit_change", summary: "task_charge −1.0 credit (estimated)", hash: "5d6e7f8a9b0c", createdAt: ago(58) },
  { seq: 9, companySlug: "sell-handmade-ceramic", actor: "worker:t-5", eventType: "email_sent", summary: "send_email → email:a1b2c3d4e5f6 (outreach #3)", hash: "e2d3c4b5a697", createdAt: ago(75) },
  { seq: 8, companySlug: "a-newsletter-about", actor: "system", eventType: "credit_change", summary: "task_refund +1.0 credit (task failed, auto-refund)", hash: "0192a3b4c5d6", createdAt: ago(90) },
  { seq: 2, companySlug: "sell-handmade-ceramic", actor: "system", eventType: "company_created", summary: "Company created from one prompt → live in 0.3 s", hash: "f00dbeef1234", createdAt: ago(240) },
  { seq: 1, companySlug: "a-newsletter-about", actor: "system", eventType: "company_created", summary: "Company created from one prompt → live in 0.3 s", hash: "deadbeef0001", createdAt: ago(300) },
];

interface ApiCompany {
  id: string; slug: string; name: string; mission: string; status: Company["status"];
  revenueCents: number; spendCents: number; moneyOutCents: number; balanceCents: number;
  tasksDone: number; tasksQueued: number;
  dailyTaskCap: number; autonomyLevel: Company["autonomyLevel"]; modelLevel: ModelLevel; isPublic: boolean;
  adMonthlyBudgetCapCents: number; emailAddress?: string | null;
}

export async function getCompanies(): Promise<Company[]> {
  if (!API_URL) return demoCompanies;
  try {
    const res = await fetch(`${API_URL}/api/companies`, { next: { revalidate: 5 } });
    const { companies } = (await res.json()) as { companies: ApiCompany[] };
    return companies;
  } catch {
    return demoCompanies;
  }
}

/**
 * The signed-in owner's own companies. Client-only — it sends the Better Auth
 * session cookie (credentials: "include"). Returns [] when signed out (401),
 * in demo mode, or if the API is unreachable.
 */
export async function getMyCompanies(): Promise<Company[]> {
  if (!API_URL) return [];
  try {
    const res = await fetch(`${API_URL}/api/companies/mine`, { credentials: "include" });
    if (!res.ok) return [];
    const { companies } = (await res.json()) as { companies: Company[] };
    return companies;
  } catch {
    return [];
  }
}

export async function getCompany(
  slug: string,
): Promise<{ company: Company; tasks: CompanyTask[] } | null> {
  if (!API_URL) {
    const company = demoCompanies.find((c) => c.slug === slug);
    return company ? { company, tasks: demoTasks[slug] ?? [] } : null;
  }
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}`, { next: { revalidate: 5 } });
    if (!res.ok) return null;
    return (await res.json()) as { company: Company; tasks: CompanyTask[] };
  } catch {
    return null;
  }
}

// no-store: these back mutation UIs (create/edit/run) that router.refresh()
// after writes — a revalidate window would show stale rows.
// Owner-only endpoint (§4): forward the caller's session cookie so the API can
// authorize. Without a cookie (a logged-out visitor) the API returns 403 and we
// degrade to an empty list — the page simply doesn't render the panel.
export async function getCompanyTasks(slug: string, cookie?: string): Promise<TaskDetail[]> {
  if (!API_URL) return demoTaskDetails[slug] ?? [];
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/tasks`, {
      cache: "no-store",
      headers: cookie ? { cookie } : undefined,
    });
    if (!res.ok) return [];
    const { tasks } = (await res.json()) as { tasks: TaskDetail[] };
    return tasks;
  } catch {
    return [];
  }
}

export async function getTask(slug: string, taskId: string, cookie?: string): Promise<TaskDetail | null> {
  if (!API_URL) return demoTaskDetails[slug]?.find((t) => t.id === taskId) ?? null;
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/tasks/${taskId}`, {
      cache: "no-store",
      headers: cookie ? { cookie } : undefined,
    });
    if (!res.ok) return null;
    const { task } = (await res.json()) as { task: TaskDetail };
    return task;
  } catch {
    return null;
  }
}

export async function getAgents(
  slug: string,
): Promise<{ agents: Agent[]; departmentPlans: DepartmentPlan[] }> {
  if (!API_URL) {
    return {
      agents: demoAgents[slug] ?? [],
      departmentPlans: slug === "sell-handmade-ceramic" ? demoDepartmentPlans : [],
    };
  }
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/agents`, { next: { revalidate: 30 } });
    if (!res.ok) return { agents: [], departmentPlans: [] };
    return (await res.json()) as { agents: Agent[]; departmentPlans: DepartmentPlan[] };
  } catch {
    return { agents: [], departmentPlans: [] };
  }
}

// Canned terminal transcript so the Vercel preview shows the real shape of a
// heartbeat: departments → CEO → dispatch → worker steps → brief.
export const demoTerminal: TerminalEvent[] = [
  { seq: 101, actor: "dept:cmo", eventType: "department_plan", payload: { headline: "Zero revenue and empty inbox signal need for foundational growth activation.", proposedTasks: ["Launch baseline customer outreach campaign"] }, createdAt: ago(9) },
  { seq: 102, actor: "dept:cto", eventType: "department_plan", payload: { headline: "Day 1 post-launch: recommend diagnostics before scaling.", proposedTasks: ["Verify website is live and publicly accessible"] }, createdAt: ago(9) },
  { seq: 103, actor: "dept:cfo", eventType: "department_plan", payload: { headline: "Critical: €5 credit runway with zero revenue requires immediate revenue focus.", proposedTasks: [] }, createdAt: ago(9) },
  { seq: 104, actor: "ceo", eventType: "ceo_plan", payload: { createdTasks: ["Verify website is live and publicly accessible"], promptHash: "a1b2c3d4e5f60708" }, createdAt: ago(8) },
  { seq: 105, actor: "system", eventType: "credit_change", payload: { delta: -1, reason: "task_charge" }, createdAt: ago(8) },
  { seq: 106, actor: "system", eventType: "task_state", payload: { title: "Verify website is live and publicly accessible", status: "running" }, createdAt: ago(8) },
  { seq: 107, actor: "worker:t-42", eventType: "worker_step", payload: { n: 1, thought: "Reading the mission for context before checking the deployment.", tool: "org.read_mission" }, createdAt: ago(7) },
  { seq: 108, actor: "worker:t-42", eventType: "tool_call", payload: { server: "org", tool: "read_mission", outcome: "ok" }, createdAt: ago(7) },
  { seq: 109, actor: "worker:t-42", eventType: "worker_step", payload: { n: 2, thought: "Checking deploy status to confirm the storefront is live.", tool: "web.get_deploy_status" }, createdAt: ago(6) },
  { seq: 110, actor: "worker:t-42", eventType: "tool_call", payload: { server: "web", tool: "get_deploy_status", outcome: "ok" }, createdAt: ago(6) },
  { seq: 111, actor: "system", eventType: "task_state", payload: { title: "Verify website is live and publicly accessible", status: "done", resultSummary: "Deployment confirmed live; browser-level verification flagged for follow-up." }, createdAt: ago(5) },
  { seq: 112, actor: "ceo", eventType: "daily_brief", payload: { brief: "Day 1: storefront confirmed live. Next heartbeat pivots to customer acquisition. Dispatched 1 task(s); stopped because: daily_task_cap_reached." }, createdAt: ago(5) },
];

export async function getCompanyEvents(
  slug: string,
): Promise<{ companyId: string | null; events: TerminalEvent[] }> {
  if (!API_URL) return { companyId: null, events: demoTerminal };
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/events?limit=200`, { cache: "no-store" });
    if (!res.ok) return { companyId: null, events: [] };
    return (await res.json()) as { companyId: string; events: TerminalEvent[] };
  } catch {
    return { companyId: null, events: [] };
  }
}

export async function getProducts(slug: string): Promise<Product[]> {
  if (!API_URL) return demoProducts[slug] ?? [];
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/products`, { next: { revalidate: 30 } });
    if (!res.ok) return [];
    const { products } = (await res.json()) as { products: Product[] };
    return products;
  } catch {
    return [];
  }
}

export async function getPayments(
  slug: string,
  cookie?: string,
): Promise<{ summary: RevenueSummary; payments: Payment[] }> {
  if (!API_URL)
    return demoPayments[slug] ?? { summary: { grossCents: 0, feesCents: 0, netCents: 0, count: 0 }, payments: [] };
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/payments`, {
      cache: "no-store",
      headers: cookie ? { cookie } : undefined,
    });
    if (!res.ok) return { summary: { grossCents: 0, feesCents: 0, netCents: 0, count: 0 }, payments: [] };
    return (await res.json()) as { summary: RevenueSummary; payments: Payment[] };
  } catch {
    return { summary: { grossCents: 0, feesCents: 0, netCents: 0, count: 0 }, payments: [] };
  }
}

export async function getCampaigns(slug: string, cookie?: string): Promise<Campaign[]> {
  if (!API_URL) return demoCampaigns[slug] ?? [];
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/campaigns`, {
      cache: "no-store",
      headers: cookie ? { cookie } : undefined,
    });
    if (!res.ok) return [];
    const { campaigns } = (await res.json()) as { campaigns: Campaign[] };
    return campaigns;
  } catch {
    return [];
  }
}

export async function getEmails(slug: string, direction?: "in" | "out", cookie?: string): Promise<Email[]> {
  if (!API_URL) {
    const all = demoEmails[slug] ?? [];
    return direction ? all.filter((e) => e.direction === direction) : all;
  }
  try {
    const qs = direction ? `?direction=${direction}` : "";
    const res = await fetch(`${API_URL}/api/companies/${slug}/emails${qs}`, {
      cache: "no-store",
      headers: cookie ? { cookie } : undefined,
    });
    if (!res.ok) return [];
    const { emails } = (await res.json()) as { emails: Email[] };
    return emails;
  } catch {
    return [];
  }
}

// Demo website analytics so the per-company Analytics panel stands alone in the
// Vercel preview; real numbers come from the site's analytics endpoint later.
const demoAnalytics: Record<string, SiteAnalytics> = {
  "sell-handmade-ceramic": { pageviews: 142, visitors: 61, sessions: 88, peakPerDay: 19 },
  "a-newsletter-about": { pageviews: 16, visitors: 8, sessions: 16, peakPerDay: 7 },
};

export async function getAnalytics(slug: string): Promise<SiteAnalytics> {
  const empty: SiteAnalytics = { pageviews: 0, visitors: 0, sessions: 0, peakPerDay: 0 };
  if (!API_URL) return demoAnalytics[slug] ?? empty;
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/analytics`, { next: { revalidate: 60 } });
    if (!res.ok) return empty;
    return (await res.json()) as SiteAnalytics;
  } catch {
    return empty;
  }
}

export async function getEmail(slug: string, emailId: string, cookie?: string): Promise<Email | null> {
  if (!API_URL) return demoEmails[slug]?.find((e) => e.id === emailId) ?? null;
  try {
    const res = await fetch(`${API_URL}/api/companies/${slug}/emails/${emailId}`, {
      cache: "no-store",
      headers: cookie ? { cookie } : undefined,
    });
    if (!res.ok) return null;
    const { email } = (await res.json()) as { email: Email };
    return email;
  } catch {
    return null;
  }
}

/** A raw (redacted) ledger row as returned by /api/ledger and /api/live. */
export interface RawLedgerEvent {
  seq: number;
  companyId: string | null;
  actor: string;
  eventType: string;
  payload: unknown;
  hash: string;
  createdAt: string;
}

/**
 * Map a raw ledger row into a display LedgerEvent. Shared by the snapshot fetch
 * and the live SSE stream so both surfaces render identical lines.
 */
export function toLedgerEvent(e: RawLedgerEvent): LedgerEvent {
  return {
    seq: e.seq,
    companySlug: e.companyId,
    actor: e.actor,
    eventType: e.eventType,
    summary: JSON.stringify(e.payload).slice(0, 120),
    hash: e.hash.slice(0, 12),
    createdAt: e.createdAt,
  };
}

export async function getLedger(): Promise<LedgerEvent[]> {
  if (!API_URL) return demoLedger;
  try {
    const res = await fetch(`${API_URL}/api/ledger?limit=50`, { next: { revalidate: 5 } });
    const { events } = (await res.json()) as { events: RawLedgerEvent[] };
    return events.map(toLedgerEvent).reverse();
  } catch {
    return demoLedger;
  }
}
