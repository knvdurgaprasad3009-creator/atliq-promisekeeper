import { NextResponse } from "next/server";
import { EXTRACTION_MODEL, FILTER_MODEL } from "@/lib/prompt";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    accessCodeRequired: Boolean(process.env.ACCESS_CODE),
    extractionModel: EXTRACTION_MODEL,
    filterModel: FILTER_MODEL,
  });
}
