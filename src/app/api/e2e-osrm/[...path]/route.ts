import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (process.env.QUOTE_E2E_MODE !== "1" || process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ code: "NotFound" }, { status: 404 });
  }
  const { path } = await params;
  const coordinatePair = path.at(-1) ?? "";
  const coordinates = coordinatePair.split(";").map((pair) => (
    pair.split(",").map(Number)
  ));
  if (
    coordinates.length !== 2
    || coordinates.some((pair) => pair.length !== 2 || pair.some((value) => !Number.isFinite(value)))
  ) {
    return NextResponse.json({ code: "InvalidQuery" }, { status: 400 });
  }
  if (request.nextUrl.searchParams.get("failure") === "malformed") {
    return NextResponse.json({ code: "Ok", routes: [] });
  }
  return NextResponse.json({
    code: "Ok",
    routes: [{
      distance: 8_000,
      duration: 900,
      geometry: { type: "LineString", coordinates },
    }],
  });
}
