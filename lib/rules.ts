// Deterministic rules engine. No AI here: matching, dates, owners, ranking and CRM-fix proposals
// are plain code so they are testable and explainable.
import type { CrmRecord, Dataset, Doc, ExtractedItem, ItemType, RunResult } from "./types";

const FREE_MAIL = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"];
const STOP = new Set(["the", "group", "ltd", "llc", "inc", "pvt", "private", "limited", "co", "and", "&", "industries", "solutions", "technologies", "advisory", "agency", "saas", "labs", "bank", "capital", "clinics", "hotels", "hospitality", "realty", "insurance", "logistics", "foods", "textiles", "health", "healthcare", "parts", "constructions", "analytics", "solar", "diagnostics", "lending", "fitness", "nbfc"]);

export const DAY = 86400000;
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

export function companyKey(name: string | null | undefined): string {
  if (!name) return "";
  const toks = name.toLowerCase().replace(/[^a-z0-9& ]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
  return toks.join(" ");
}

export type MatchKind = "email" | "domain" | "company" | "ambiguous" | "none";
export interface Match { kind: MatchKind; record: CrmRecord | null; candidates: CrmRecord[]; note: string }

export function matchAccount(item: ExtractedItem, doc: Doc, crm: CrmRecord[]): Match {
  const clientEmails = [item.contact_email, ...doc.emails].filter((e): e is string => !!e && !e.endsWith("@atliq.com"));
  // 1. exact contact email
  if (item.contact_email) {
    const hits = crm.filter((r) => r.contact_email && r.contact_email.toLowerCase() === item.contact_email);
    if (hits.length) return pick(hits, "email");
  }
  // 2. company name (as written by the AI) against CRM company names
  const ck = companyKey(item.company);
  if (ck) {
    const hits = crm.filter((r) => {
      const rk = companyKey(r.company);
      return rk && (rk === ck || rk.split(" ")[0] === ck.split(" ")[0]);
    });
    if (hits.length) return pick(hits, "company");
  }
  // 3. corporate email domain (only when the item names no company of its own)
  if (!ck) {
    for (const e of clientEmails) {
      const dom = e.split("@")[1];
      if (!dom || FREE_MAIL.includes(dom)) continue;
      const hits = crm.filter((r) => r.contact_email && r.contact_email.toLowerCase().endsWith("@" + dom));
      if (hits.length) return pick(hits, "domain");
    }
  }
  // 4. person surname only (e.g. "S. Kulkarni" from a personal address): never guess
  const surname = item.person?.trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, "");
  if (surname && surname.length > 2) {
    const hits = crm.filter((r) => r.contact_name.toLowerCase().split(/\s+/).pop()?.replace(/[^a-z]/g, "") === surname);
    const companies = new Set(hits.map((h) => companyKey(h.company)));
    if (companies.size > 1) return { kind: "ambiguous", record: null, candidates: hits, note: `"${item.person}" matches ${hits.length} CRM contacts at different companies` };
    if (hits.length === 1 && !ck) return { kind: "ambiguous", record: null, candidates: hits, note: `Only a surname match ("${item.person}"); needs confirmation` };
  }
  return { kind: "none", record: null, candidates: [], note: "Not in CRM" };
}

function pick(hits: CrmRecord[], kind: MatchKind): Match {
  const companies = new Set(hits.map((h) => companyKey(h.company).split(" ")[0]));
  if (companies.size > 1) return { kind: "ambiguous", record: null, candidates: hits, note: "Matches several different CRM accounts" };
  // Duplicates of one account: prefer the record with an active status and a value
  const sorted = [...hits].sort((a, b) => (b.est_value_usd ?? 0) - (a.est_value_usd ?? 0));
  return { kind, record: sorted[0], candidates: hits, note: hits.length > 1 ? `Account has ${hits.length} CRM records (possible duplicate)` : "" };
}

export interface BriefItem extends ExtractedItem {
  key: string;
  docId: string;
  docDate: string;
  account: string;
  crmId: string | null;
  match: Match;
  owner: string | null;
  value: number | null;
  daysLeft: number | null;
  ageDays: number;
  score: number;
  reason: string;
}

const TYPE_BONUS: Partial<Record<ItemType, number>> = {
  client_deadline: 10, client_request: 8, promise_by_atliq: 8, new_lead: 8, lost_deal_active: 8, revisit: 6, expansion_signal: 5,
};
export const BRIEF_TYPES: ItemType[] = ["promise_by_atliq", "client_deadline", "client_request", "new_lead", "expansion_signal", "revisit", "lost_deal_active"];

export function scoreItem(i: Pick<BriefItem, "type" | "daysLeft" | "ageDays" | "value" | "match">): { score: number; reason: string } {
  const parts: string[] = [];
  let s = 0;
  if (i.daysLeft !== null) {
    if (i.daysLeft < 0) { s += 60 + Math.min(-i.daysLeft, 30); parts.push(`overdue ${-i.daysLeft}d`); }
    else if (i.daysLeft <= 3) { s += 55; parts.push(i.daysLeft === 0 ? "due today" : `${i.daysLeft}d left`); }
    else if (i.daysLeft <= 7) { s += 45; parts.push(`${i.daysLeft}d left`); }
    else if (i.daysLeft <= 14) { s += 30; parts.push(`${i.daysLeft}d left`); }
    else { s += 10; parts.push(`${i.daysLeft}d left`); }
  } else if (i.type === "client_request" || i.type === "promise_by_atliq" || i.type === "new_lead") {
    s += Math.min(10 + i.ageDays, 50); parts.push(`waiting ${i.ageDays}d`);
  } else { s += 10; }
  if (i.value) { s += Math.min(i.value / 2000, 40); parts.push(`$${Math.round(i.value / 1000)}k`); }
  s += TYPE_BONUS[i.type] ?? 0;
  if (i.match.kind === "none") parts.push("not in CRM");
  return { score: Math.round(s), reason: parts.join(" · ") };
}

export interface CrmFix {
  id: string;
  kind: "new_record" | "status" | "last_contact" | "next_followup" | "owner" | "value" | "duplicate" | "do_not_contact";
  crmId: string | null;
  account: string;
  field: string;
  from: string;
  to: string;
  why: string;
  evidence: { docId: string; quote: string }[];
}

export interface UnsureItem { id: string; kind: "ambiguous" | "low_confidence" | "suspicious" | "conflict" | "dropped"; title: string; detail: string; docId: string; quote?: string }

export interface Analysis {
  brief: BriefItem[];
  done: BriefItem[];
  fixes: CrmFix[];
  unsure: UnsureItem[];
  doNotContact: string[];
  stats: { docs: number; relevant: number; items: number; dropped: number; suspicious: number; inputTokens: number; outputTokens: number };
}

const SELLERS = ["Bhavin", "Dhaval", "Karandeep", "Jay", "Pranav", "Ayush"];
function normOwner(o: string | null | undefined) {
  if (!o) return null;
  const f = SELLERS.find((s) => o.toLowerCase().includes(s.toLowerCase()));
  return f ?? null;
}

function atliqRecipient(doc: Doc): string | null {
  const m = doc.text.match(/\*\*To:\*\*([^\n]*)/);
  return m ? normOwner(m[1]) : null;
}

export function analyse(ds: Dataset, run: RunResult | null): Analysis {
  const empty: Analysis = { brief: [], done: [], fixes: [], unsure: [], doNotContact: [], stats: { docs: ds.docs.length, relevant: 0, items: 0, dropped: 0, suspicious: 0, inputTokens: 0, outputTokens: 0 } };
  if (!run) return empty;
  const asOf = ds.asOf;
  const all: BriefItem[] = [];
  const unsure: UnsureItem[] = [];
  const st = empty.stats;

  for (const doc of ds.docs) {
    const r = run.results[doc.id];
    if (!r) continue;
    st.inputTokens += r.usage?.input_tokens ?? 0; st.outputTokens += r.usage?.output_tokens ?? 0;
    if (r.relevant) st.relevant++;
    st.dropped += r.dropped.length;
    if (r.suspicious) {
      st.suspicious++;
      unsure.push({ id: `sus-${doc.id}`, kind: "suspicious", title: `Suspicious instructions in "${doc.title}"`, detail: `${r.suspiciousReason ?? ""}. No action taken; the instructions were treated as data.`, docId: doc.id });
    }
    r.dropped.forEach((d, k) => unsure.push({ id: `drop-${doc.id}-${k}`, kind: "dropped", title: `Dropped an AI item: ${d.reason}`, detail: String(d.item?.summary ?? ""), docId: doc.id, quote: String(d.item?.quote ?? "") }));
    r.items.forEach((it, k) => {
      st.items++;
      const match = matchAccount(it, doc, ds.crm);
      const rec = match.record;
      const owner = normOwner(rec?.owner) ?? normOwner(it.owner_hint) ?? (it.type === "promise_by_atliq" ? null : atliqRecipient(doc));
      const value = rec?.est_value_usd ?? it.value_usd ?? null;
      const daysLeft = it.due_date ? daysBetween(asOf, it.due_date) : null;
      const ageDays = Math.max(0, daysBetween(doc.date, asOf));
      const account = rec?.company ?? it.company ?? (match.candidates[0]?.company ?? it.person ?? "Unknown");
      const bi: BriefItem = { ...it, key: `${doc.id}#${k}`, docId: doc.id, docDate: doc.date, account, crmId: rec?.lead_id ?? null, match, owner, value, daysLeft, ageDays, score: 0, reason: "" };
      Object.assign(bi, scoreItem(bi));
      all.push(bi);
      if (match.kind === "ambiguous") unsure.push({ id: `amb-${bi.key}`, kind: "ambiguous", title: `Which account? ${it.person ?? it.company ?? "Unknown sender"}`, detail: `${match.note}: ${match.candidates.map((c) => `${c.contact_name} (${c.company}, ${c.lead_id})`).join("; ")}. Not attached to any account until a seller confirms.`, docId: doc.id, quote: it.quote });
      else if (it.confidence === "low") unsure.push({ id: `low-${bi.key}`, kind: "low_confidence", title: `Low confidence: ${it.summary}`, detail: "The AI marked this item as unclear. Shown here instead of the brief.", docId: doc.id, quote: it.quote });
    });
  }

  // Do-not-contact accounts suppress all follow-up suggestions
  const dnc = new Set(all.filter((i) => i.type === "do_not_contact").map((i) => i.crmId ?? companyKey(i.account)));
  const isDnc = (i: BriefItem) => dnc.has(i.crmId ?? companyKey(i.account));

  // Later documents supersede earlier ones for the same account and type (e.g. a request answered in a newer thread)
  const brief = all
    .filter((i) => BRIEF_TYPES.includes(i.type) && i.status === "open" && i.match.kind !== "ambiguous" && i.confidence === "high" && !isDnc(i))
    .sort((a, b) => b.score - a.score);
  const done = all.filter((i) => i.status === "done" && BRIEF_TYPES.includes(i.type));

  // Conflicting dates: same account, two client deadlines with different dates that share a key word
  const dl = all.filter((i) => i.type === "client_deadline" && i.due_date);
  for (let a = 0; a < dl.length; a++) for (let b = a + 1; b < dl.length; b++) {
    const x = dl[a], y = dl[b];
    if (x.account !== y.account || x.due_date === y.due_date || x.docId === y.docId) continue;
    const kw = ["board", "budget", "review", "decision", "proposal"].find((w) => x.summary.toLowerCase().includes(w) && y.summary.toLowerCase().includes(w));
    if (kw) unsure.push({ id: `conf-${x.key}-${y.key}`, kind: "conflict", title: `Conflicting dates for ${x.account} (${kw})`, detail: `${x.due_date} in ${x.docId} vs ${y.due_date} in ${y.docId}. The newer source (${x.docDate > y.docDate ? x.docId : y.docId}) is preferred; please confirm.`, docId: x.docDate > y.docDate ? x.docId : y.docId, quote: (x.docDate > y.docDate ? x : y).quote });
  }

  return { brief, done, fixes: crmFixes(ds, all, isDnc), unsure, doNotContact: [...dnc], stats: st };
}

function crmFixes(ds: Dataset, all: BriefItem[], isDnc: (i: BriefItem) => boolean): CrmFix[] {
  const fixes: CrmFix[] = [];
  const add = (f: Omit<CrmFix, "id">) => { if (!fixes.some((x) => x.kind === f.kind && x.crmId === f.crmId && x.account === f.account)) fixes.push({ ...f, id: `${f.kind}:${f.crmId ?? f.account}` }); };
  const byRec = new Map<string, BriefItem[]>();
  for (const i of all) if (i.crmId) byRec.set(i.crmId, [...(byRec.get(i.crmId) ?? []), i]);

  for (const rec of ds.crm) {
    const items = byRec.get(rec.lead_id) ?? [];
    if (!items.length) continue;
    const ev = (xs: BriefItem[]) => xs.slice(0, 2).map((x) => ({ docId: x.docId, quote: x.quote }));
    // Do not contact
    const dncItems = items.filter((i) => i.type === "do_not_contact");
    if (dncItems.length) add({ kind: "do_not_contact", crmId: rec.lead_id, account: rec.company, field: "status", from: rec.status || "(blank)", to: "Lost (do not contact)", why: "Contact asked AtliQ to stop following up.", evidence: ev(dncItems) });
    // Lost but active
    const active = items.filter((i) => i.type === "lost_deal_active" || (rec.status === "Lost" && ["client_request", "client_deadline"].includes(i.type) && i.docDate > (rec.last_contact_date || "")));
    if (rec.status === "Lost" && active.length && !dncItems.length) add({ kind: "status", crmId: rec.lead_id, account: rec.company, field: "status", from: "Lost", to: "Contacted", why: "The client re-engaged after the deal was marked Lost.", evidence: ev(active) });
    // Explicit stage change
    const stage = items.filter((i) => i.suggested_crm_status && i.suggested_crm_status !== rec.status && !(i.suggested_crm_status === "Lost" && active.length));
    if (stage.length && !dncItems.length) {
      const latest = [...stage].sort((a, b) => b.docDate.localeCompare(a.docDate))[0];
      add({ kind: "status", crmId: rec.lead_id, account: rec.company, field: "status", from: rec.status || "(blank)", to: latest.suggested_crm_status!, why: latest.summary, evidence: ev([latest]) });
    }
    // Last contact date
    const latestDoc = items.map((i) => i.docDate).sort().pop()!;
    if (!rec.last_contact_date || latestDoc > rec.last_contact_date) add({ kind: "last_contact", crmId: rec.lead_id, account: rec.company, field: "last_contact_date", from: rec.last_contact_date || "(blank)", to: latestDoc, why: "A newer email or note exists for this account.", evidence: ev(items.filter((i) => i.docDate === latestDoc)) });
    // Next follow-up date
    const upcoming = items.filter((i) => i.status === "open" && i.due_date && i.due_date >= ds.asOf && !isDnc(i)).sort((a, b) => a.due_date!.localeCompare(b.due_date!));
    if (!rec.next_followup_date && upcoming.length) add({ kind: "next_followup", crmId: rec.lead_id, account: rec.company, field: "next_followup_date", from: "(blank)", to: upcoming[0].due_date!, why: upcoming[0].summary, evidence: ev(upcoming) });
    // Owner
    const ownerItem = items.find((i) => i.owner);
    if (!rec.owner && ownerItem) add({ kind: "owner", crmId: rec.lead_id, account: rec.company, field: "owner", from: "(blank)", to: ownerItem.owner!, why: "This person is handling the conversation.", evidence: ev([ownerItem]) });
    // Value
    const valItem = items.find((i) => i.value_usd);
    if (!rec.est_value_usd && valItem) add({ kind: "value", crmId: rec.lead_id, account: rec.company, field: "est_value_usd", from: "(blank)", to: String(valItem.value_usd), why: "A budget or price was stated by the client or in the notes.", evidence: ev([valItem]) });
  }

  // New records for accounts not in the CRM
  const unmatched = all.filter((i) => i.match.kind === "none" && ["new_lead", "client_request", "client_deadline", "revisit"].includes(i.type));
  const seen = new Set<string>();
  for (const i of unmatched) {
    const k = companyKey(i.company ?? i.person ?? "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const ev = unmatched.filter((x) => companyKey(x.company ?? x.person ?? "") === k);
    const referrer = ev.find((x) => x.referrer)?.referrer;
    add({ kind: "new_record", crmId: null, account: i.company ?? i.person ?? "Unknown", field: "new lead", from: "(not in CRM)",
      to: [i.company, i.person, i.contact_email, referrer ? `Referral: ${referrer}` : null, i.owner ? `Owner: ${i.owner}` : null].filter(Boolean).join(" · "),
      why: "This company is talking to AtliQ but has no CRM record.", evidence: ev.slice(0, 2).map((x) => ({ docId: x.docId, quote: x.quote })) });
  }

  // Duplicates (CRM-only rule, never auto-merged)
  for (let a = 0; a < ds.crm.length; a++) for (let b = a + 1; b < ds.crm.length; b++) {
    const x = ds.crm[a], y = ds.crm[b];
    const sameCo = companyKey(x.company).split(" ")[0] === companyKey(y.company).split(" ")[0] && companyKey(x.company) !== "";
    const sameContact = x.contact_email && x.contact_email.toLowerCase() === y.contact_email.toLowerCase();
    if (sameCo || sameContact) add({ kind: "duplicate", crmId: x.lead_id, account: x.company, field: "duplicate?", from: `${x.lead_id} (${x.owner || "no owner"}, ${x.status || "no status"})`, to: `${y.lead_id} (${y.owner || "no owner"}, ${y.status || "no status"})`,
      why: sameContact ? "Same contact email on two records. Could be one deal entered twice or two real opportunities: a human decides." : "Same company name on two records. Review: merge or keep as separate opportunities.", evidence: [] });
  }
  return fixes;
}
