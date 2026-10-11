import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { FILTER_MODEL } from "@/lib/prompt";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Two-sentence morning summary of a seller's ranked items. Uses only the item lines sent (already grounded). */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI disabled" }, { status: 503 });
  const access = process.env.ACCESS_CODE;
  if (access && req.headers.get("x-access-code") !== access) return NextResponse.json({ error: "Access code required" }, { status: 401 });
  const { seller, lines } = await req.json().catch(() => ({}));
  if (!Array.isArray(lines) || lines.length === 0) return NextResponse.json({ summary: "Nothing owed today." });
  const safe = lines.slice(0, 10).map((l: unknown) => String(l).slice(0, 300));
  const client = new Anthropic({ apiKey });
  const m = await client.messages.create({
    model: FILTER_MODEL, max_tokens: 200,
    system: "You write a two-sentence morning summary for a busy founder-seller. Use ONLY the items given. Do not add facts, numbers or names that are not in the items. Plain, direct language.",
    messages: [{ role: "user", content: `Seller: ${String(seller).slice(0, 40)}\nRanked items (most urgent first):\n${safe.map((l: string, i: number) => `${i + 1}. ${l}`).join("\n")}` }],
  });
  const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join(" ").trim();
  return NextResponse.json({ summary: text });
}
