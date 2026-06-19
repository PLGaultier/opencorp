import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@opencorp/schema";
import type { MiddlewareHandler } from "hono";

/**
 * Auth (§3: Better Auth, orgs = conglomerates). GitHub OAuth only — the first
 * sign-in creates the user's conglomerate with an owner membership, so every
 * authenticated user can immediately create companies.
 *
 * Public transparency surfaces (/api/ledger, /api/live, /api/companies, /c/*)
 * stay unauthenticated by design (§9.2) — auth protects owner actions and
 * money movement only.
 *
 * Dev escape hatch: OPENCORP_AUTH_DISABLED=1 makes requireAuth inject a
 * synthetic user so demo scripts and local flows run without signup.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

export const AUTH_DISABLED = process.env.OPENCORP_AUTH_DISABLED === "1";
export const DEV_USER_ID = "dev-user";

const authSql = postgres(DATABASE_URL, { max: 3 });
const db = drizzle(authSql, { schema });

// §3 — social login. GitHub OAuth when configured (preferred over passwords).
// Callback to register in the GitHub OAuth App:
//   {API_URL}/api/auth/callback/github  (e.g. http://localhost:3001/api/auth/callback/github)
const GITHUB_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_SECRET = process.env.GITHUB_CLIENT_SECRET;
export const GITHUB_ENABLED = Boolean(GITHUB_ID && GITHUB_SECRET);

export const auth = betterAuth({
  baseURL: process.env.API_URL ?? "http://localhost:3001",
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // GitHub-only for now (simplicity): no email+password.
  emailAndPassword: { enabled: false },
  socialProviders: GITHUB_ENABLED
    ? { github: { clientId: GITHUB_ID!, clientSecret: GITHUB_SECRET! } }
    : {},
  trustedOrigins: [WEB_ORIGIN],
  databaseHooks: {
    user: {
      create: {
        // orgs = conglomerates: every new user gets one, as owner
        after: async (user) => {
          const [cong] = await authSql<{ id: string }[]>`
            INSERT INTO conglomerates (owner_user_id, name)
            VALUES (${user.id}, ${`${user.name || user.email}'s conglomerate`})
            RETURNING id`;
          await authSql`
            INSERT INTO memberships (user_id, conglomerate_id, role)
            VALUES (${user.id}, ${cong!.id}, 'owner')`;
          // §10 pillar 1: the wallet is real money (cents). New owners get a
          // €5 trial allowance, burned at real API cost. Reason must be a valid
          // credit_reason enum value ('grant'); meta marks it as onboarding.
          await authSql`
            INSERT INTO credit_entries (conglomerate_id, delta, reason, meta)
            VALUES (${cong!.id}, 500, 'grant', ${authSql.json({ kind: "onboarding" })})`;
        },
      },
    },
  },
});

export async function getSessionUser(req: Request): Promise<{ id: string } | null> {
  if (AUTH_DISABLED) return { id: DEV_USER_ID };
  const session = await auth.api.getSession({ headers: req.headers });
  return session ? { id: session.user.id } : null;
}

/** Hono middleware: 401 without a session; sets c.var.userId. */
export const requireAuth: MiddlewareHandler<{ Variables: { userId: string } }> = async (
  c,
  next,
) => {
  const user = await getSessionUser(c.req.raw);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", user.id);
  await next();
};

export async function userConglomerateIds(
  sql: postgres.Sql,
  userId: string,
): Promise<string[]> {
  if (AUTH_DISABLED) {
    const rows = await sql<{ id: string }[]>`SELECT id FROM conglomerates`;
    return rows.map((r) => r.id);
  }
  const rows = await sql<{ conglomerate_id: string }[]>`
    SELECT conglomerate_id FROM memberships WHERE user_id = ${userId}`;
  return rows.map((r) => r.conglomerate_id);
}

export async function userCanAccessCompany(
  sql: postgres.Sql,
  userId: string,
  companyId: string,
): Promise<boolean> {
  if (AUTH_DISABLED) return true;
  const [row] = await sql`
    SELECT 1 FROM companies c
    JOIN memberships m ON m.conglomerate_id = c.conglomerate_id
    WHERE c.id = ${companyId} AND m.user_id = ${userId}`;
  return Boolean(row);
}

export async function userIsMemberOfConglomerate(
  sql: postgres.Sql,
  userId: string,
  conglomerateId: string,
): Promise<boolean> {
  if (AUTH_DISABLED) return true;
  const [row] = await sql`
    SELECT 1 FROM memberships
    WHERE user_id = ${userId} AND conglomerate_id = ${conglomerateId}`;
  return Boolean(row);
}
