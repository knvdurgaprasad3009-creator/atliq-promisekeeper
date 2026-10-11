import { ITEM_TYPES, type CrmStatus, type DroppedItem, type ExtractedItem } from "./types";

/** Normalise text for quote matching: unify quotes/dashes, collapse whitespace, drop markdown emphasis. */
export function norm(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Guardrail 1: the quote must exist verbatim (after whitespace/punctuation normalisation) in the source. */
export function quoteIsInSource(quote: string, source: string) {
  const q = norm(quote).replace(/^["']|["']$/g, "");
  if (q.length < 8) return false;
  return norm(source).includes(q);
}

/** Guardrail 2: deterministic prompt-injection tripwire, independent of the model. */
const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /(system|admin) (note|message|prompt) to (the )?(ai|assistant|model)/i,
  /do not (mention|tell|show) this (note|message) to the user/i,
];
export function injectionTripwire(text: string): string | null {
  const hit = INJECTION_PATTERNS.find((p) => p.test(text));
  return hit ? `Matched injection pattern ${hit}` : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: CrmStatus[] = ["New", "Contacted", "Proposal Sent", "Won", "Lost"];

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Guardrail 3: schema validation + quote check. Returns kept items and dropped items with reasons. */
export function validateItems(rawItems: unknown, source: string): { items: ExtractedItem[]; dropped: DroppedItem[] } {
  const items: ExtractedItem[] = [];
  const dropped: DroppedItem[] = [];
  if (!Array.isArray(rawItems)) return { items, dropped };
  for (const r of rawItems as any[]) {
    if (!r || typeof r !== "object") continue;
    if (!ITEM_TYPES.includes(r.type)) { dropped.push({ item: r, reason: `Unknown type "${r.type}"` }); continue; }
    const quote = str(r.quote);
    if (!quote || !quoteIsInSource(quote, source)) { dropped.push({ item: r, reason: "Quote not found verbatim in the source document" }); continue; }
    let due = str(r.due_date);
    if (due && (!ISO.test(due) || isNaN(Date.parse(due)))) due = null;
    let value = typeof r.value_usd === "number" && isFinite(r.value_usd) && r.value_usd > 0 ? r.value_usd : null;
    // Value must be grounded: some digits of it should appear in the document
    if (value && !new RegExp(String(Math.round(value / 1000))).test(source)) value = null;
    items.push({
      type: r.type,
      summary: str(r.summary) || quote.slice(0, 120),
      quote,
      company: str(r.company),
      person: str(r.person),
      contact_email: str(r.contact_email)?.toLowerCase() ?? null,
      owner_hint: str(r.owner_hint),
      date_phrase: str(r.date_phrase),
      due_date: due,
      status: r.status === "done" ? "done" : "open",
      value_usd: value,
      suggested_crm_status: STATUSES.includes(r.suggested_crm_status) ? r.suggested_crm_status : null,
      referrer: str(r.referrer),
      confidence: r.confidence === "low" ? "low" : "high",
    });
  }
  return { items, dropped };
}
