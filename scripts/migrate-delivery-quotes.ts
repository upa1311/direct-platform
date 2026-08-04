import { neon } from "@neondatabase/serverless";
import { readMigrationFiles } from "drizzle-orm/migrator";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = neon(databaseUrl);
const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
await sql`CREATE TABLE IF NOT EXISTS __direct_migrations (
  hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
)`;
for (const migration of migrations) {
  const existing = await sql`SELECT hash FROM __direct_migrations WHERE hash = ${migration.hash}`;
  if (existing.length) continue;
  await sql.transaction((transaction) => [
    ...migration.sql.map((statement) => transaction.query(statement, [])),
    transaction.query(
      "INSERT INTO __direct_migrations (hash) VALUES ($1)",
      [migration.hash],
    ),
  ]);
  console.log(`Applied ${migration.hash}`);
}
