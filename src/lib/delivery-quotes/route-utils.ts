import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AdminAuthenticationError } from "./api-auth";
import { QuoteRateLimitError } from "./repository";
import { RouteProviderError } from "./osrm";

export function apiError(error: unknown): NextResponse {
  if (error instanceof AdminAuthenticationError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof QuoteRateLimitError) {
    return NextResponse.json({ error: error.message }, { status: 429 });
  }
  if (error instanceof RouteProviderError) {
    const status = error.code === "NO_ROUTE" ? 422 : 503;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "Некорректные параметры запроса." }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  const configurationError = message.includes("is not configured")
    || message.includes("must contain at least");
  if (configurationError) {
    return NextResponse.json({ error: "Сервис котировок ещё не настроен." }, { status: 503 });
  }
  return NextResponse.json({ error: message }, { status: 400 });
}

export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
