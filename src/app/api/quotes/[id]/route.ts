import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminActor } from "@/lib/delivery-quotes/api-auth";
import { getQuoteRepository } from "@/lib/delivery-quotes/repository-factory";
import { apiError } from "@/lib/delivery-quotes/route-utils";

const updateSchema = z.object({
  status: z.enum(["draft", "confirmed", "cancelled"]),
  notes: z.string().max(4_000),
}).strict();

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdminActor();
    const { id } = await params;
    const quote = await getQuoteRepository().findById(id);
    if (!quote) return NextResponse.json({ error: "Котировка не найдена." }, { status: 404 });
    return NextResponse.json({ quote });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdminActor();
    const { id } = await params;
    const input = updateSchema.parse(await request.json());
    const quote = await getQuoteRepository().updateStatusAndNotes(
      id,
      input.status,
      input.notes,
    );
    if (!quote) return NextResponse.json({ error: "Котировка не найдена." }, { status: 404 });
    return NextResponse.json({ quote });
  } catch (error) {
    return apiError(error);
  }
}
