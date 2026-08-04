import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminActor } from "@/lib/delivery-quotes/api-auth";
import { verifySignedQuoteCalculation } from "@/lib/delivery-quotes/calculation-signature";
import { getQuoteRepository } from "@/lib/delivery-quotes/repository-factory";
import { apiError } from "@/lib/delivery-quotes/route-utils";
import type { SignedQuoteCalculation } from "@/lib/delivery-quotes/types";

const listSchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["draft", "confirmed", "cancelled"]).optional(),
  dateFrom: z.iso.datetime().optional(),
  dateTo: z.iso.datetime().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const saveSchema = z.object({
  envelope: z.object({
    calculation: z.record(z.string(), z.unknown()),
    actorGithubUserId: z.string(),
    expiresAt: z.string(),
    signature: z.string(),
  }),
  notes: z.string().max(4_000).default(""),
}).strict();

export async function GET(request: NextRequest) {
  try {
    await requireAdminActor();
    const input = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const result = await getQuoteRepository().list({
      query: input.q,
      status: input.status,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      offset: input.offset,
      limit: input.limit,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireAdminActor();
    const input = saveSchema.parse(await request.json());
    const calculation = verifySignedQuoteCalculation(
      input.envelope as unknown as SignedQuoteCalculation,
      actor,
    );
    const quote = await getQuoteRepository().save(calculation, actor, input.notes);
    return NextResponse.json({ quote }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
