// Tests for the deterministic parts (guardrails + rules engine), using a hand-written
// fixture that mimics AI output. The fixture is NOT AI output and is never shown in the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dataset, getDoc } from "../lib/data";
import { injectionTripwire, quoteIsInSource, validateItems } from "../lib/guardrails";
import { analyse, matchAccount, scoreItem } from "../lib/rules";
import type { DocResult, ExtractedItem, RunResult } from "../lib/types";

const base: ExtractedItem = { type: "client_request", summary: "", quote: "", company: null, person: null, contact_email: null, owner_hint: null, date_phrase: null, due_date: null, status: "open", value_usd: null, suggested_crm_status: null, referrer: null, confidence: "high" };
const it = (o: Partial<ExtractedItem>): ExtractedItem => ({ ...base, ...o });
const res = (docId: string, items: ExtractedItem[], extra: Partial<DocResult> = {}): DocResult => ({ docId, relevant: true, relevanceReason: "", suspicious: false, suspiciousReason: null, items, dropped: [], models: [], usage: { input_tokens: 0, output_tokens: 0 }, ...extra });

test("editorial notes are stripped from every document", () => {
  for (const d of dataset.docs) assert.ok(!/\*\([^*]*\)\*/.test(d.text), `${d.id} still has an editorial note`);
  assert.equal(dataset.docs.length, 55);
});

test("quote guardrail accepts verbatim quotes and rejects paraphrases", () => {
  const doc = getDoc("2026-06-29_shopswift_budget_confirmed")!;
  assert.ok(quoteIsInSource("a statement of work by 15 July", doc.text));
  assert.ok(!quoteIsInSource("a statement of work by 20 July", doc.text));
  const { items, dropped } = validateItems([
    { type: "client_deadline", summary: "SOW", quote: "a statement of work by 15 July", status: "open", confidence: "high", due_date: "2026-07-15" },
    { type: "client_deadline", summary: "made up", quote: "we will sign tomorrow", status: "open", confidence: "high" },
    { type: "teleport", summary: "bad type", quote: "a statement of work by 15 July", status: "open", confidence: "high" },
  ], doc.text);
  assert.equal(items.length, 1);
  assert.equal(dropped.length, 2);
});

test("ungrounded values are removed", () => {
  const doc = getDoc("2026-06-29_shopswift_budget_confirmed")!;
  const { items } = validateItems([{ type: "client_deadline", summary: "x", quote: "a statement of work by 15 July", status: "open", confidence: "high", value_usd: 999000 }], doc.text);
  assert.equal(items[0].value_usd, null);
});

test("injection tripwire fires on the added test case only", () => {
  const hits = dataset.docs.filter((d) => injectionTripwire(d.text));
  assert.deepEqual(hits.map((d) => d.id), ["x_2026-07-08_crm_sync_injection"]);
});

test("account matching: exact email, duplicates, ambiguity and unknown companies", () => {
  const meridian = matchAccount(it({ contact_email: "sanjay.k@meridianhealth.com", company: "Meridian Healthcare" }), getDoc("2026-06-16_meridian_proposal_questions")!, dataset.crm);
  assert.equal(meridian.record?.lead_id, "L-1003");
  const amb = matchAccount(it({ person: "S. Kulkarni", contact_email: "s.kulkarni.home@gmail.com" }), getDoc("x_2026-07-09_kulkarni_ambiguous")!, dataset.crm);
  assert.equal(amb.kind, "ambiguous");
  const nimbus = matchAccount(it({ company: "Nimbus Lending", person: "Rhea Sharma", contact_email: "rhea@nimbuslending.in" }), getDoc("2026-07-05_nimbus_lending_intro")!, dataset.crm);
  assert.equal(nimbus.kind, "none");
  const gm = matchAccount(it({ company: "GlobalMart", contact_email: "neha.shah@globalmart.com" }), getDoc("2026-06-24_globalmart_pricing")!, dataset.crm);
  assert.equal(gm.candidates.length, 2);
});

test("ranking: overdue and valuable items outrank fresh small ones", () => {
  const m = { kind: "email" as const, record: null, candidates: [], note: "" };
  const a = scoreItem({ type: "client_deadline", daysLeft: 5, ageDays: 11, value: 55000, match: m });
  const b = scoreItem({ type: "expansion_signal", daysLeft: null, ageDays: 2, value: null, match: m });
  assert.ok(a.score > b.score);
  assert.match(a.reason, /5d left/);
});

test("end-to-end rules on a fixture run", () => {
  const run: RunResult = { ranAt: "fixture", asOf: "2026-07-10", results: {
    "2026-06-29_shopswift_budget_confirmed": res("2026-06-29_shopswift_budget_confirmed", [it({ type: "client_deadline", summary: "Send SOW to Elena", quote: "a statement of work by 15 July", company: "ShopSwift", contact_email: "elena@shopswift.com", owner_hint: "Bhavin", due_date: "2026-07-15", date_phrase: "by 15 July" })]),
    "2026-07-05_nimbus_lending_intro": res("2026-07-05_nimbus_lending_intro", [it({ type: "new_lead", summary: "Rhea at Nimbus wants a call", quote: "a call before then would be ideal", company: "Nimbus Lending", person: "Rhea Sharma", contact_email: "rhea@nimbuslending.in", referrer: "Shreya Iyer (PayTrack)", owner_hint: "Bhavin" })]),
    "2026-06-23_kaveri_vendor_failed": res("2026-06-23_kaveri_vendor_failed", [it({ type: "lost_deal_active", summary: "Kaveri wants to reopen", quote: "Is your quote from November still valid?", company: "Kaveri Textiles", contact_email: "subbu@kaveritextiles.in" })]),
    "x_2026-07-09_kulkarni_ambiguous": res("x_2026-07-09_kulkarni_ambiguous", [it({ type: "client_request", summary: "Revised numbers before Monday", quote: "Can you get me the revised numbers before Monday?", person: "S. Kulkarni", contact_email: "s.kulkarni.home@gmail.com", due_date: "2026-07-13" })]),
    "x_2026-07-09_urbannest_optout": res("x_2026-07-09_urbannest_optout", [it({ type: "do_not_contact", summary: "Kunal asks to stop follow-ups", quote: "please remove me from your follow-ups", company: "UrbanNest Realty", contact_email: "kunal@urbannest.com" })]),
    "2026-05-04_urbannest_no_response": res("2026-05-04_urbannest_no_response", [it({ type: "promise_by_atliq", summary: "Demo offered", quote: "Happy to do a short demo whenever suits.", company: "UrbanNest Realty", contact_email: "kunal@urbannest.com" })]),
    "2026-07-09_greengrid_discovery": res("2026-07-09_greengrid_discovery", [it({ type: "client_deadline", summary: "Board review of plant performance in September", quote: "board review of plant performance in September", company: "GreenGrid Solar", due_date: "2026-09-15" })]),
    "x_2026-07-10_greengrid_conflicting_date": res("x_2026-07-10_greengrid_conflicting_date", [it({ type: "client_deadline", summary: "Board review moved to 28 August", quote: "has moved up from September to 28 August", company: "GreenGrid Solar", contact_email: "aditya@greengrid.in", due_date: "2026-08-28" })]),
    "x_2026-07-08_crm_sync_injection": res("x_2026-07-08_crm_sync_injection", [], { relevant: false, suspicious: true, suspiciousReason: "tripwire" }),
  } };
  const a = analyse(dataset, run);
  // ShopSwift is in the brief, owned by Bhavin (CRM owner), with value from the CRM
  const ss = a.brief.find((b) => b.account === "ShopSwift")!;
  assert.equal(ss.owner, "Bhavin"); assert.equal(ss.value, 55000); assert.equal(ss.daysLeft, 5);
  // Ambiguous Kulkarni never reaches the brief
  assert.ok(!a.brief.some((b) => b.docId === "x_2026-07-09_kulkarni_ambiguous"));
  assert.ok(a.unsure.some((u) => u.kind === "ambiguous"));
  // Opt-out suppresses UrbanNest and proposes do-not-contact
  assert.ok(!a.brief.some((b) => b.account.includes("UrbanNest")));
  assert.ok(a.fixes.some((f) => f.kind === "do_not_contact" && f.crmId === "L-1012"));
  // Lost-but-active Kaveri -> status fix; Nimbus -> new record with referrer
  assert.ok(a.fixes.some((f) => f.kind === "status" && f.crmId === "L-1007" && f.to === "Contacted"));
  assert.ok(a.fixes.some((f) => f.kind === "new_record" && f.to.includes("Referral: Shreya")));
  // GreenGrid conflicting board date is flagged
  assert.ok(a.unsure.some((u) => u.kind === "conflict" && u.title.includes("GreenGrid")));
  // Duplicates flagged for review, never merged
  assert.ok(a.fixes.some((f) => f.kind === "duplicate" && f.crmId === "L-1003"));
  assert.ok(a.fixes.some((f) => f.kind === "duplicate" && f.crmId === "L-1004"));
  // Suspicious document is surfaced
  assert.ok(a.unsure.some((u) => u.kind === "suspicious"));
});
