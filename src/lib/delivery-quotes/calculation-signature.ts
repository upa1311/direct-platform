import { createHmac, timingSafeEqual } from "node:crypto";

import type { QuoteCalculation, SignedQuoteCalculation } from "./types";

function signingSecret(explicitSecret?: string): string {
  const secret = explicitSecret
    ?? process.env.QUOTE_TOKEN_SECRET
    ?? process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("QUOTE_TOKEN_SECRET or AUTH_SECRET must contain at least 32 characters");
  }
  return secret;
}

function canonicalPayload(
  calculation: QuoteCalculation,
  actorGithubUserId: string,
  expiresAt: string,
): string {
  return JSON.stringify({ calculation, actorGithubUserId, expiresAt });
}

function signatureFor(payload: string, secret?: string): string {
  return createHmac("sha256", signingSecret(secret))
    .update(payload)
    .digest("base64url");
}

export function signQuoteCalculation(
  calculation: QuoteCalculation,
  actorGithubUserId: string,
  options: { now?: Date; ttlSeconds?: number; secret?: string } = {},
): SignedQuoteCalculation {
  const now = options.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (options.ttlSeconds ?? 15 * 60) * 1_000,
  ).toISOString();
  const payload = canonicalPayload(calculation, actorGithubUserId, expiresAt);
  return Object.freeze({
    calculation,
    actorGithubUserId,
    expiresAt,
    signature: signatureFor(payload, options.secret),
  });
}

export function verifySignedQuoteCalculation(
  envelope: SignedQuoteCalculation,
  actorGithubUserId: string,
  options: { now?: Date; secret?: string } = {},
): QuoteCalculation {
  if (envelope.actorGithubUserId !== actorGithubUserId) {
    throw new Error("Расчёт принадлежит другой административной сессии.");
  }
  const expiresAt = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now ?? new Date()).getTime()) {
    throw new Error("Расчёт устарел. Выполните его повторно перед сохранением.");
  }
  const payload = canonicalPayload(
    envelope.calculation,
    envelope.actorGithubUserId,
    envelope.expiresAt,
  );
  const expected = Buffer.from(signatureFor(payload, options.secret));
  const actual = Buffer.from(envelope.signature ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Подпись расчёта недействительна.");
  }
  return envelope.calculation;
}
