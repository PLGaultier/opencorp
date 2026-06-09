import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/tables.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://opencorp:opencorp@localhost:5432/opencorp",
  },
});
