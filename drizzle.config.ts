import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/delivery-quotes/db-schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://not-configured.invalid/direct",
  },
});
