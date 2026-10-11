import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { dataset, getDoc } from "@/lib/data";
import { EXTRACTION_MODEL, FILTER_MODEL, FILTER_TOOL, RECORD_TOOL, docMessage, extractionSystemPrompt, filterPrompt } from "@/lib/prompt";
import { injectionTripwire, validateItems } from "@/lib/guardrails";
import type { DocResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set on the server." }, { status: 503 });

  const access = process.env.ACCESS_CODE;
  if (access && req.headers.get("x-access-code") !== access) {
    return NextResponse.json({ error: "Access code required to run the AI." }, { status: 401 });
  }

  // The client sends only a document id. Text comes from the server-side dataset, so
  // nobody can push arbitrary text through our API key.
  const { docId } = await req.json().catch(() => ({}));
  const doc = typeof docId === "string" ? getDoc(docId) : undefined;
  if (!doc) return NextResponse.json({ error: "Unknown document" }, { status: 404 });

  const client = new Anthropic({ apiKey });
  const result: DocResult = {
    docId: doc.id, relevant: true, relevanceReason: "", suspicious: false, suspiciousReason: null,
    items: [], dropped: [], models: [], usage: { input_tokens: 0, output_tokens: 0 },
  };

  // Guardrail: deterministic injection tripwire runs before any model sees the text.
  const trip = injectionTripwire(doc.text);
  if (trip) { result.suspicious = true; result.suspiciousReason = trip; }

  try {
    // Step 1: cheap relevance filter (Haiku)
    const f = await client.messages.create({
      model: FILTER_MODEL, max_tokens: 200,
      tools: [FILTER_TOOL as any], tool_choice: { type: "tool", name: "classify" },
      messages: [{ role: "user", content: filterPrompt(doc) }],
    });
    result.models.push(FILTER_MODEL);
    result.usage.input_tokens += f.usage.input_tokens; result.usage.output_tokens += f.usage.output_tokens;
    const fb: any = f.content.find((b) => b.type === "tool_use");
    result.relevant = fb?.input?.relevant !== false;
    result.relevanceReason = fb?.input?.reason ?? "";
    if (!result.relevant) return NextResponse.json(result);

    // Step 2: extraction (Sonnet) with forced structured output
    const m = await client.messages.create({
      model: EXTRACTION_MODEL, max_tokens: 3000,
      system: extractionSystemPrompt(dataset.asOf, dataset.team),
      tools: [RECORD_TOOL as any], tool_choice: { type: "tool", name: "record_items" },
      messages: [{ role: "user", content: docMessage(doc) }],
    });
    result.models.push(EXTRACTION_MODEL);
    result.usage.input_tokens += m.usage.input_tokens; result.usage.output_tokens += m.usage.output_tokens;
    const tb: any = m.content.find((b) => b.type === "tool_use");
    const input = tb?.input ?? {};
    if (input.suspicious_instruction) {
      result.suspicious = true;
      result.suspiciousReason = [result.suspiciousReason, `Model: ${input.suspicious_reason ?? "instruction aimed at an AI"}`].filter(Boolean).join(" | ");
    }
    // Guardrail: schema + verbatim-quote check. Anything that fails is dropped and reported.
    const { items, dropped } = validateItems(input.items, doc.text);
    result.items = items;
    result.dropped = dropped;
    // Guardrail: in a suspicious document, never keep items that would change deal state.
    if (result.suspicious) {
      const risky = result.items.filter((i) => i.type === "status_signal" || i.suggested_crm_status);
      result.items = result.items.filter((i) => !risky.includes(i));
      result.dropped.push(...risky.map((item) => ({ item, reason: "Suspicious document: stage-change items blocked" })));
    }
    return NextResponse.json(result);
  } catch (e: any) {
    result.error = e?.message ?? String(e);
    return NextResponse.json(result, { status: 502 });
  }
}
