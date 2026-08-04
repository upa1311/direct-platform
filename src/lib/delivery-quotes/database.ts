import "server-only";

import { neon } from "@neondatabase/serverless";

export interface QuoteSqlClient {
  query<T extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

let client: QuoteSqlClient | null = null;

export function getQuoteSqlClient(): QuoteSqlClient {
  if (client) return client;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
  const sql = neon(databaseUrl);
  client = {
    async query<T extends Record<string, unknown>>(text: string, params = []) {
      return await sql.query(text, [...params]) as T[];
    },
  };
  return client;
}

export function __setQuoteSqlClientForTests(value: QuoteSqlClient | null): void {
  client = value;
}
