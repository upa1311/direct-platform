import { NextRequest, NextResponse } from "next/server";

import { requireAdminActor } from "@/lib/delivery-quotes/api-auth";
import { getQuoteRepository } from "@/lib/delivery-quotes/repository-factory";
import { apiError } from "@/lib/delivery-quotes/route-utils";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdminActor();
    const { id } = await params;
    const quote = await getQuoteRepository().findById(id);
    if (!quote) return NextResponse.json({ error: "Котировка не найдена." }, { status: 404 });
    return NextResponse.json(quote, {
      headers: {
        "Content-Disposition": `attachment; filename=${quote.quoteNumber}.json`,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
