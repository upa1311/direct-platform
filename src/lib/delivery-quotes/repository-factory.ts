import { randomUUID } from "node:crypto";

import {
  PostgresQuoteRepository,
  QuoteRateLimitError,
  type QuoteListInput,
  type QuoteListResult,
} from "./repository";
import type { QuoteCalculation, QuoteStatus, StoredQuote } from "./types";

export interface QuoteRepository {
  save(calculation: QuoteCalculation, createdBy: string, notes: string, now?: Date): Promise<StoredQuote>;
  findById(id: string): Promise<StoredQuote | null>;
  list(input?: QuoteListInput): Promise<QuoteListResult>;
  updateStatusAndNotes(id: string, status: QuoteStatus, notes: string): Promise<StoredQuote | null>;
  enforceRateLimit(
    actorId: string,
    options?: { now?: Date; limit?: number; windowSeconds?: number },
  ): Promise<void>;
}

interface E2eStore {
  quotes: Map<string, StoredQuote>;
  rateLimits: Map<string, { startedAt: number; count: number }>;
  sequence: number;
}

const shared = globalThis as typeof globalThis & { __directQuoteE2eStore?: E2eStore };

function e2eStore(): E2eStore {
  shared.__directQuoteE2eStore ??= {
    quotes: new Map(),
    rateLimits: new Map(),
    sequence: 0,
  };
  return shared.__directQuoteE2eStore;
}

class E2eQuoteRepository implements QuoteRepository {
  async save(
    calculation: QuoteCalculation,
    createdBy: string,
    notes: string,
    now = new Date(),
  ): Promise<StoredQuote> {
    const store = e2eStore();
    store.sequence += 1;
    const quote: StoredQuote = Object.freeze({
      ...calculation,
      id: randomUUID(),
      quoteNumber: `DQ-${now.toISOString().slice(0, 10).replaceAll("-", "")}-E2E${String(store.sequence).padStart(5, "0")}`,
      createdAt: now.toISOString(),
      createdBy,
      status: "draft",
      notes,
    });
    store.quotes.set(quote.id, quote);
    return quote;
  }

  async findById(id: string): Promise<StoredQuote | null> {
    return e2eStore().quotes.get(id) ?? null;
  }

  async list(input: QuoteListInput = {}): Promise<QuoteListResult> {
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(500, input.limit ?? 50));
    const query = input.query?.toLocaleLowerCase("ru");
    const items = [...e2eStore().quotes.values()]
      .filter((quote) => !input.status || quote.status === input.status)
      .filter((quote) => !query || [quote.quoteNumber, quote.origin.label, quote.destination.label]
        .some((value) => value.toLocaleLowerCase("ru").includes(query)))
      .filter((quote) => !input.dateFrom || quote.createdAt >= input.dateFrom)
      .filter((quote) => !input.dateTo || quote.createdAt < input.dateTo)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
  }

  async updateStatusAndNotes(
    id: string,
    status: QuoteStatus,
    notes: string,
  ): Promise<StoredQuote | null> {
    const current = e2eStore().quotes.get(id);
    if (!current) return null;
    const updated = Object.freeze({ ...current, status, notes });
    e2eStore().quotes.set(id, updated);
    return updated;
  }

  async enforceRateLimit(
    actorId: string,
    options: { now?: Date; limit?: number; windowSeconds?: number } = {},
  ): Promise<void> {
    const now = (options.now ?? new Date()).getTime();
    const limit = options.limit ?? 12;
    const windowMs = (options.windowSeconds ?? 60) * 1_000;
    const current = e2eStore().rateLimits.get(actorId);
    const next = !current || current.startedAt <= now - windowMs
      ? { startedAt: now, count: 1 }
      : { ...current, count: current.count + 1 };
    e2eStore().rateLimits.set(actorId, next);
    if (next.count > limit) throw new QuoteRateLimitError();
  }
}

export function getQuoteRepository(): QuoteRepository {
  if (process.env.QUOTE_E2E_MODE === "1" && process.env.VERCEL_ENV !== "production") {
    return new E2eQuoteRepository();
  }
  return new PostgresQuoteRepository();
}
