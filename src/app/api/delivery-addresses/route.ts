import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminActor } from "@/lib/delivery-quotes/api-auth";
import {
  allDeliveryAddresses,
  catalogMetadata,
  searchDeliveryAddresses,
} from "@/lib/delivery-quotes/catalog";
import { apiError, csvCell } from "@/lib/delivery-quotes/route-utils";

const searchSchema = z.object({
  q: z.string().max(200).optional(),
  settlement: z.string().max(100).optional(),
  street: z.string().max(150).optional(),
  house: z.string().max(50).optional(),
  zoneId: z.coerce.number().int().min(1).max(4).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  view: z.enum(["search", "map", "csv"]).default("search"),
});

export async function GET(request: NextRequest) {
  try {
    await requireAdminActor();
    const input = searchSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    if (input.view === "map") {
      return NextResponse.json({
        metadata: catalogMetadata(),
        items: allDeliveryAddresses().map(({ id, lon, lat, zoneId, status }) => (
          { id, lon, lat, zoneId, status }
        )),
      });
    }
    if (input.view === "csv") {
      const lines = ["id,address,lon,lat,status,zone_id"];
      for (const item of allDeliveryAddresses()) {
        lines.push([
          item.id,
          item.label,
          item.lon,
          item.lat,
          item.status,
          item.zoneId,
        ].map(csvCell).join(","));
      }
      return new NextResponse(`\uFEFF${lines.join("\r\n")}\r\n`, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=direct-delivery-addresses.csv",
        },
      });
    }
    return NextResponse.json({
      metadata: catalogMetadata(),
      ...searchDeliveryAddresses({
        query: input.q,
        settlement: input.settlement,
        street: input.street,
        house: input.house,
        zoneId: input.zoneId,
        offset: input.offset,
        limit: input.limit,
      }),
    });
  } catch (error) {
    return apiError(error);
  }
}
