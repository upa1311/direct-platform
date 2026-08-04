import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminActor } from "@/lib/delivery-quotes/api-auth";
import { calculateDeliveryQuote } from "@/lib/delivery-quotes/calculator";
import { signQuoteCalculation } from "@/lib/delivery-quotes/calculation-signature";
import { getQuoteRepository } from "@/lib/delivery-quotes/repository-factory";
import { apiError } from "@/lib/delivery-quotes/route-utils";

const inputSchema = z.object({
  originAddressId: z.string().min(1).max(200),
  destinationAddressId: z.string().min(1).max(200),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const actor = await requireAdminActor();
    const input = inputSchema.parse(await request.json());
    const repository = getQuoteRepository();
    await repository.enforceRateLimit(actor);
    const calculation = await calculateDeliveryQuote(input);
    return NextResponse.json({
      calculation,
      envelope: signQuoteCalculation(calculation, actor),
    });
  } catch (error) {
    return apiError(error);
  }
}
