import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminActor } from "@/lib/delivery-quotes/api-auth";
import { getQuoteRepository } from "@/lib/delivery-quotes/repository-factory";
import { apiError, csvCell } from "@/lib/delivery-quotes/route-utils";

const querySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["draft", "confirmed", "cancelled"]).optional(),
  dateFrom: z.iso.datetime().optional(),
  dateTo: z.iso.datetime().optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireAdminActor();
    const input = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const result = await getQuoteRepository().list({ ...input, limit: 500 });
    const header = [
      "quote_number", "created_at", "status", "origin_address_id", "origin_address",
      "destination_address_id", "destination_address", "distance_meters", "duration_seconds",
      "external_meters", "base_price_cents", "external_surcharge_cents", "total_price_cents",
      "currency", "tariff_version", "checkpoint_id", "created_by", "notes",
    ];
    const lines = [header.join(",")];
    for (const quote of result.items) {
      lines.push([
        quote.quoteNumber, quote.createdAt, quote.status, quote.origin.id, quote.origin.label,
        quote.destination.id, quote.destination.label, quote.routeDistanceMeters,
        quote.routeDurationSeconds, quote.externalMeters, quote.basePriceCents,
        quote.externalSurchargeCents, quote.totalPriceCents, quote.currency,
        quote.tariffVersion, quote.checkpoint.id, quote.createdBy, quote.notes,
      ].map(csvCell).join(","));
    }
    return new NextResponse(`\uFEFF${lines.join("\r\n")}\r\n`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=direct-delivery-quotes.csv",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
