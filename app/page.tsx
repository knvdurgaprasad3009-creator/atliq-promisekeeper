"use client";
import { useEffect, useMemo, useState } from "react";
import { dataset, answerKey, getDoc } from "@/lib/data";
import { analyse, type BriefItem, type CrmFix } from "@/lib/rules";
import { evaluate } from "@/lib/evals";
import { TYPE_LABEL, type DocResult, type RunResult } from "@/lib/types";

type Tab = "brief" | "fixes" | "unsure" | "evals" | "audit" | "data";
type Decision = { state: "done" | "snoozed" | "approved" | "rejected" | "reassigned"; to?: string; at: string };
interface AuditEntry { at: string; action: string; target: string; detail: string }

const SELLERS = ["Bhavin", "Dhaval", "Karandeep", "Jay"];
const LS = { run: "pk_run_v1", dec: "pk_decisions_v1", audit: "pk_audit_v1" };
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage may be unavailable */ } };
const fmtDate = (d: string | null) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

export default function Home() {
  const [tab, setTab] = useState<Tab>("brief");
  const [run, setRun] = useState<RunResult | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [seller, setSeller] = useState<string>("All");
  const [status, setStatus] = useState<{ aiEnabled: boolean; accessCodeRequired: boolean; extractionModel: string; filterModel: string } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [viewDoc, setViewDoc] = useState<{ id: string; quote?: string } | null>(null);
  const [summary, setSummary] = useState<Record<string, string>>({});
  const [loadedFrom, setLoadedFrom] = useState<string>("");

  useEffect(() => {
    setDecisions(load(LS.dec, {}));
    setAudit(load(LS.audit, []));
    const r = load<RunResult | null>(LS.run, null);
    if (r) { setRun(r); setLoadedFrom("this browser"); }
    else fetch("/cache/run.json").then((x) => (x.ok ? x.json() : null)).then((j) => { if (j?.results) { setRun(j); setLoadedFrom("saved demo run"); } }).catch(() => {});
    const getStatus = (tries: number) => fetch("/api/status").then((x) => x.json()).then(setStatus).catch(() => { if (tries > 0) setTimeout(() => getStatus(tries - 1), 1500); });
    getStatus(3);
  }, []);

  const analysis = useMemo(() => analyse(dataset, run), [run]);
  const evals = useMemo(() => evaluate(answerKey, analysis, run), [analysis, run]);

  const log = (action: string, target: string, detail: string) => {
    const e = { at: new Date().toISOString(), action, target, detail };
    setAudit((a) => { const n = [e, ...a]; save(LS.audit, n); return n; });
  };
  const decide = (id: string, d: Omit<Decision, "at">, label: string, detail: string) => {
    setDecisions((x) => { const n = { ...x, [id]: { ...d, at: new Date().toISOString() } }; save(LS.dec, n); return n; });
    log(d.state, label, detail);
  };
  const undo = (id: string, label: string) => {
    setDecisions((x) => { const n = { ...x }; delete n[id]; save(LS.dec, n); return n; });
    log("undo", label, "Decision reverted");
  };

  async function runAI() {
    setErr(null);
    const docs = dataset.docs;
    const results: Record<string, DocResult> = {};
    setProgress({ done: 0, total: docs.length });
    let done = 0, failures = 0;
    const queue = [...docs];
    const worker = async () => {
      while (queue.length) {
        const d = queue.shift()!;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch("/api/extract", { method: "POST", headers: { "content-type": "application/json", "x-access-code": code }, body: JSON.stringify({ docId: d.id }) });
            const j = await res.json();
            if (!res.ok && !j?.docId) throw new Error(j?.error || res.statusText);
            if (j.error && attempt === 0) continue;
            results[d.id] = j; if (j.error) failures++;
            break;
          } catch (e: any) {
            if (attempt === 1) { failures++; setErr(e.message); }
          }
        }
        done++; setProgress({ done, total: docs.length });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const r: RunResult = { ranAt: new Date().toISOString(), asOf: dataset.asOf, results };
    setRun(r); save(LS.run, r); setLoadedFrom("this browser");
    setProgress(null);
    log("ai_run", `${Object.keys(results).length} documents`, failures ? `${failures} failed` : "All documents processed");
  }

  function exportRun() {
    if (!run) return;
    const blob = new Blob([JSON.stringify(run, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "run.json"; a.click();
  }

  async function summarise(who: string, items: BriefItem[]) {
    const lines = items.slice(0, 10).map((i) => `${TYPE_LABEL[i.type]}: ${i.summary} (${i.account}; ${i.reason})`);
    setSummary((s) => ({ ...s, [who]: "Summarising..." }));
    try {
      const r = await fetch("/api/summary", { method: "POST", headers: { "content-type": "application/json", "x-access-code": code }, body: JSON.stringify({ seller: who, lines }) });
      const j = await r.json();
      setSummary((s) => ({ ...s, [who]: j.summary || j.error }));
    } catch (e: any) { setSummary((s) => ({ ...s, [who]: e.message })); }
  }

  // Brief filtered by seller and decisions
  const ownerOf = (i: BriefItem) => (decisions[i.key]?.state === "reassigned" ? decisions[i.key]!.to! : i.owner);
  const visible = analysis.brief.filter((i) => !["done", "snoozed"].includes(decisions[i.key]?.state ?? ""));
  const mine = seller === "All" ? visible : seller === "Unowned" ? visible.filter((i) => !ownerOf(i)) : visible.filter((i) => ownerOf(i) === seller);
  const shown = seller === "All" ? mine : mine.slice(0, 10);
  const doneCount = Object.values(decisions).filter((d) => d.state === "done").length;
  const overdue = visible.filter((i) => (i.daysLeft ?? 0) < 0 || (i.daysLeft === null && i.ageDays > 14)).length;
  const fixesOpen = analysis.fixes.filter((f) => !decisions[f.id]).length;
  const valueAtRisk = useMemo(() => {
    const byAcc = new Map<string, number>();
    visible.forEach((i) => { if (i.value && (i.daysLeft === null ? i.ageDays > 7 : i.daysLeft <= 21) && i.crmId) byAcc.set(i.crmId, i.value); });
    return [...byAcc.values()].reduce((a, b) => a + b, 0);
  }, [visible]);

  // CRM copy with approved changes applied
  const crmView = useMemo(() => {
    const rows = dataset.crm.map((r) => ({ ...r, _changed: [] as string[] }));
    for (const f of analysis.fixes) {
      if (decisions[f.id]?.state !== "approved" || !f.crmId) continue;
      const r = rows.find((x) => x.lead_id === f.crmId);
      if (!r || f.kind === "duplicate") continue;
      const field = f.field as keyof typeof r;
      (r as any)[field] = f.kind === "do_not_contact" ? "Lost" : f.kind === "value" ? Number(f.to) : f.to;
      r._changed.push(String(field));
    }
    return rows;
  }, [analysis.fixes, decisions]);

  const tokens = analysis.stats.inputTokens + analysis.stats.outputTokens;
  const costUpper = (analysis.stats.inputTokens * 2 + analysis.stats.outputTokens * 10) / 1e6;

  return (
    <>
      <header className="top">
        <div className="wrap">
          <div className="brand">
            <h1>AtliQ PromiseKeeper</h1>
            <p>Every client promise, kept. Data as of {fmtDate(dataset.asOf)} 2026 · {dataset.docs.length} emails and notes · {dataset.crm.length} CRM records</p>
          </div>
          <div className="runbox">
            {status?.accessCodeRequired && <input className="code" placeholder="Access code" value={code} onChange={(e) => setCode(e.target.value)} />}
            {progress ? (
              <><div className="progress"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div> Reading {progress.done}/{progress.total}...</>
            ) : (
              <button className="btn primary" onClick={runAI} disabled={!status?.aiEnabled} title={status?.aiEnabled ? "" : "Set ANTHROPIC_API_KEY on the server"}>
                {run ? "Re-run AI analysis" : "Run AI analysis"}
              </button>
            )}
            {run && <button className="btn" onClick={exportRun}>Export run</button>}
          </div>
        </div>
      </header>

      <main className="wrap">
        {status && !status.aiEnabled && <div className="notice">Live AI is off: the server has no ANTHROPIC_API_KEY. {run ? `Showing the ${loadedFrom}.` : "Add the key in Vercel settings to run the analysis."}</div>}
        {err && <div className="notice">Some documents failed: {err}</div>}
        {run && (
          <p className="meta">AI run: {new Date(run.ranAt).toLocaleString()} ({loadedFrom}) · models: {status?.filterModel ?? "Haiku"} (filter), {status?.extractionModel ?? "Sonnet"} (extraction) · {tokens.toLocaleString()} tokens, at most ${costUpper.toFixed(2)}</p>
        )}

        <div className="kpis">
          <div className="kpi"><b>{visible.length}</b><span>open items in the brief</span></div>
          <div className="kpi"><b>{overdue}</b><span>overdue or waiting &gt; 14 days</span></div>
          <div className="kpi"><b>${Math.round(valueAtRisk / 1000)}k</b><span>CRM value with an open item due within 3 weeks</span></div>
          <div className="kpi"><b>{doneCount}</b><span>marked done this session</span></div>
          <div className="kpi"><b>{Math.round(answerKey.baseline.rate * 100)}%</b><span>commitments met on time before PromiseKeeper (baseline)</span></div>
        </div>

        <nav className="tabs">
          {([["brief", "Daily brief", visible.length], ["fixes", "CRM fixes", fixesOpen], ["unsure", "Unsure & flagged", analysis.unsure.length], ["evals", "Evals", null], ["audit", "Audit log", audit.length], ["data", "Data", null]] as [Tab, string, number | null][]).map(([t, l, n]) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{l}{n !== null && <span className="count">{n}</span>}</button>
          ))}
        </nav>

        {!run && <div className="empty">No analysis yet. Press <b>Run AI analysis</b> to read all {dataset.docs.length} documents (about a minute).</div>}

        {run && tab === "brief" && (
          <section>
            <div className="chips">
              {["All", ...SELLERS, "Unowned"].map((s) => <button key={s} className={`chip ${seller === s ? "on" : ""}`} onClick={() => setSeller(s)}>{s === "All" ? "Team view" : s}</button>)}
            </div>
            {seller !== "All" && (
              <div className="summary">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>{seller === "Unowned" ? "Items with no owner" : `${seller}'s top ${Math.min(10, mine.length)} today`}</b>
                  {status?.aiEnabled && mine.length > 0 && <button className="btn small" onClick={() => summarise(seller, mine)}>Summarise my day</button>}
                </div>
                {summary[seller] && <p style={{ margin: "6px 0 0" }}>{summary[seller]}</p>}
                {mine.length === 0 && <p style={{ margin: "6px 0 0" }}>Nothing owed today.</p>}
              </div>
            )}
            {shown.map((i, n) => <ItemCard key={i.key} i={i} rank={n + 1} owner={ownerOf(i)} onDoc={setViewDoc}
              onDone={() => decide(i.key, { state: "done" }, `${i.account}: ${i.summary}`, "Marked done")}
              onSnooze={() => decide(i.key, { state: "snoozed" }, `${i.account}: ${i.summary}`, "Snoozed")}
              onReassign={(to) => decide(i.key, { state: "reassigned", to }, `${i.account}: ${i.summary}`, `Reassigned to ${to}`)} />)}
            {seller !== "All" && mine.length > 10 && <p className="meta">{mine.length - 10} more items are in the team view. The personal brief is capped at 10 to avoid alert fatigue.</p>}
            <details style={{ marginTop: 16 }}><summary className="meta">How items are ranked (rules, not AI)</summary>
              <p className="meta">Score = urgency (overdue: 60+; due in 0-3 days: 55; 4-7: 45; 8-14: 30; later: 10; undated requests: 10 + days waiting, max 50) + deal value (value / $2,000, max 40) + type (client deadline 10; request, promise, new lead, revived deal 8; revisit 6; cross-sell 5). Items in the Unsure list, low-confidence items and do-not-contact accounts never reach the brief.</p>
            </details>
          </section>
        )}

        {run && tab === "fixes" && (
          <section>
            <p className="meta">PromiseKeeper never changes the CRM by itself. Each change below needs a human decision; approved changes are applied to the in-browser CRM copy (Data tab) and logged.</p>
            {analysis.fixes.length === 0 && <div className="empty">No CRM fixes suggested.</div>}
            {analysis.fixes.map((f) => <FixCard key={f.id} f={f} d={decisions[f.id]} onDoc={setViewDoc}
              onApprove={() => decide(f.id, { state: "approved" }, `${f.account} ${f.field}`, `${f.from} → ${f.to}`)}
              onReject={() => decide(f.id, { state: "rejected" }, `${f.account} ${f.field}`, `Rejected: ${f.from} → ${f.to}`)}
              onUndo={() => undo(f.id, `${f.account} ${f.field}`)} />)}
          </section>
        )}

        {run && tab === "unsure" && (
          <section>
            <p className="meta">Things PromiseKeeper will not guess about. Nothing here reaches the brief or the CRM until a person looks at it.</p>
            {analysis.unsure.length === 0 && <div className="empty">Nothing unsure.</div>}
            {analysis.unsure.map((u) => (
              <div className="card" key={u.id}>
                <div className="row"><span className={`pill ${u.kind === "suspicious" ? "red" : u.kind === "dropped" ? "grey" : "amber"}`}>{({ ambiguous: "Ambiguous account", low_confidence: "Low confidence", suspicious: "Suspicious", conflict: "Conflicting dates", dropped: "Dropped by guardrail" } as any)[u.kind]}</span><span className="meta">{getDoc(u.docId)?.title}</span></div>
                <h3>{u.title}</h3>
                <p className="meta" style={{ margin: 0 }}>{u.detail}</p>
                {u.quote && <blockquote>{u.quote}</blockquote>}
                <button className="btn small" onClick={() => setViewDoc({ id: u.docId, quote: u.quote })}>Open source</button>
              </div>
            ))}
          </section>
        )}

        {run && tab === "evals" && (
          <section>
            <p className="meta">Measured against our answer key: {answerKey.commitments.length} commitments, {answerKey.missing_leads.length} missing leads and {answerKey.signals.length} signals labelled by hand from the dataset's editorial notes, which the AI never sees. Baseline: {answerKey.baseline.met} of {answerKey.baseline.due} commitments due by 10 Jul were met ({Math.round(answerKey.baseline.rate * 100)}%).</p>
            <h3>Launch gates</h3>
            <div className="tablewrap"><table><thead><tr><th>Eval</th><th>Result</th><th>Target</th><th>Pass</th></tr></thead><tbody>
              {evals.rows.map((r) => <tr key={r.name}><td>{r.name}{r.detail && <div className="meta">{r.detail}</div>}</td><td>{r.value}</td><td>{r.target}</td><td>{r.pass ? <span className="pill green">Pass</span> : <span className="pill red">Below</span>}</td></tr>)}
            </tbody></table></div>
            <h3 style={{ marginTop: 20 }}>Safety tests (added test cases)</h3>
            <div className="tablewrap"><table><thead><tr><th>Test</th><th>Result</th><th>Expected</th><th>Pass</th></tr></thead><tbody>
              {evals.safety.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.value}</td><td>{r.target}</td><td>{r.pass ? <span className="pill green">Pass</span> : <span className="pill red">Fail</span>}</td></tr>)}
            </tbody></table></div>
            {evals.notFound.length > 0 && (<>
              <h3 style={{ marginTop: 20 }}>Labelled items not found in this run ({evals.notFound.length})</h3>
              <div className="tablewrap"><table><thead><tr><th>Account</th><th>Item</th><th>Status</th><th>Source</th></tr></thead><tbody>
                {evals.notFound.map((k: any) => <tr key={k.id}><td>{k.account}</td><td>{k.summary}</td><td>{k.status}</td><td><a href="#" onClick={(e) => { e.preventDefault(); setViewDoc({ id: k.doc }); }}>{k.doc}</a></td></tr>)}
              </tbody></table></div></>)}
            {evals.unsupported.length > 0 && (<>
              <h3 style={{ marginTop: 20 }}>Brief items not in the answer key ({evals.unsupported.length}): review by hand</h3>
              <div className="tablewrap"><table><thead><tr><th>Account</th><th>Item</th><th>Type</th><th>Source</th></tr></thead><tbody>
                {evals.unsupported.map((i) => <tr key={i.key}><td>{i.account}</td><td>{i.summary}</td><td>{TYPE_LABEL[i.type]}</td><td><a href="#" onClick={(e) => { e.preventDefault(); setViewDoc({ id: i.docId, quote: i.quote }); }}>{i.docId}</a></td></tr>)}
              </tbody></table></div></>)}
          </section>
        )}

        {tab === "audit" && (
          <section>
            <p className="meta">Every AI run and every human decision, newest first. Stored in this browser for the prototype.</p>
            {audit.length === 0 ? <div className="empty">No actions yet.</div> : (
              <div className="tablewrap"><table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
                {audit.map((a, k) => <tr key={k}><td>{new Date(a.at).toLocaleString()}</td><td>{a.action}</td><td>{a.target}</td><td>{a.detail}</td></tr>)}
              </tbody></table></div>)}
          </section>
        )}

        {tab === "data" && (
          <section>
            <h3>CRM (approved changes highlighted)</h3>
            <div className="tablewrap" style={{ maxHeight: 420 }}><table><thead><tr>{["lead_id", "company", "contact_name", "status", "est_value_usd", "owner", "last_contact_date", "next_followup_date"].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>
              {crmView.map((r) => <tr key={r.lead_id}>{(["lead_id", "company", "contact_name", "status", "est_value_usd", "owner", "last_contact_date", "next_followup_date"] as const).map((h) => <td key={h} className={r._changed.includes(h) ? "changed" : ""}>{String(r[h] ?? "")}</td>)}</tr>)}
            </tbody></table></div>
            <h3 style={{ marginTop: 20 }}>Documents the AI reads (editorial notes removed)</h3>
            {dataset.docs.map((d) => (
              <div key={d.id} className="row" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                <span className="meta" style={{ minWidth: 90 }}>{d.date}</span>
                <a href="#" onClick={(e) => { e.preventDefault(); setViewDoc({ id: d.id }); }}>{d.title}</a>
                {d.synthetic && <span className="pill amber">added test case</span>}
                {run?.results[d.id] && <span className="meta">{run.results[d.id].items.length} items</span>}
              </div>
            ))}
          </section>
        )}
      </main>

      {viewDoc && <DocModal id={viewDoc.id} quote={viewDoc.quote} onClose={() => setViewDoc(null)} />}
      <footer>AtliQ PromiseKeeper prototype · Capstone 1 · Kokku Naga Venkata Durga Prasad · Synthetic data only. The system never emails clients or edits the CRM without approval.</footer>
    </>
  );
}

function dueLabel(i: BriefItem) {
  if (i.daysLeft === null) return i.ageDays > 0 ? <span className={`pill ${i.ageDays > 14 ? "red" : "amber"}`}>waiting {i.ageDays}d</span> : null;
  if (i.daysLeft < 0) return <span className="pill red">overdue {-i.daysLeft}d · was due {fmtDate(i.due_date)}</span>;
  return <span className={`pill ${i.daysLeft <= 7 ? "amber" : "grey"}`}>due {fmtDate(i.due_date)} · {i.daysLeft}d left</span>;
}

function ItemCard({ i, rank, owner, onDoc, onDone, onSnooze, onReassign }: { i: BriefItem; rank: number; owner: string | null; onDoc: (d: { id: string; quote?: string }) => void; onDone: () => void; onSnooze: () => void; onReassign: (to: string) => void }) {
  const doc = getDoc(i.docId);
  return (
    <div className="card">
      <div className="row">
        <span className="rank">#{rank}</span>
        <span className="pill">{TYPE_LABEL[i.type]}</span>
        {dueLabel(i)}
        {i.match.kind === "none" && <span className="pill amber">not in CRM</span>}
        {i.match.candidates.length > 1 && <span className="pill grey">duplicate CRM records</span>}
      </div>
      <h3>{i.account}{i.crmId && <span className="meta"> · {i.crmId}</span>}</h3>
      <div>{i.summary}</div>
      <div className="meta" style={{ marginTop: 4 }}>
        Owner: <b>{owner ?? "unassigned"}</b>{i.value ? ` · value $${i.value.toLocaleString()}` : ""} · why ranked here: {i.reason}
        {i.date_phrase && ` · said: "${i.date_phrase}"`}
      </div>
      <blockquote>{i.quote}</blockquote>
      <div className="row">
        <button className="btn small good" onClick={onDone}>Done</button>
        <button className="btn small" onClick={onSnooze}>Snooze</button>
        <select defaultValue="" onChange={(e) => e.target.value && onReassign(e.target.value)} aria-label="Reassign">
          <option value="" disabled>Reassign...</option>
          {["Bhavin", "Dhaval", "Karandeep", "Jay", "Pranav", "Ayush"].map((s) => <option key={s}>{s}</option>)}
        </select>
        <button className="btn small" onClick={() => onDoc({ id: i.docId, quote: i.quote })}>Source: {doc?.kind === "note" ? "note" : "email"} {i.docDate}</button>
      </div>
    </div>
  );
}

function FixCard({ f, d, onDoc, onApprove, onReject, onUndo }: { f: CrmFix; d?: Decision; onDoc: (x: { id: string; quote?: string }) => void; onApprove: () => void; onReject: () => void; onUndo: () => void }) {
  const label: Record<CrmFix["kind"], string> = { new_record: "Add missing lead", status: "Fix status", last_contact: "Update last contact", next_followup: "Set next follow-up", owner: "Assign owner", value: "Add deal value", duplicate: "Possible duplicate", do_not_contact: "Do not contact" };
  return (
    <div className="card">
      <div className="row"><span className={`pill ${f.kind === "duplicate" || f.kind === "do_not_contact" ? "amber" : ""}`}>{label[f.kind]}</span><span className="meta">{f.crmId ?? "new record"}</span>
        {d && <span className={`pill ${d.state === "approved" ? "green" : "grey"}`}>{d.state}</span>}</div>
      <h3>{f.account}</h3>
      <div><b>{f.field}:</b> {f.from} → <b>{f.to}</b></div>
      <div className="meta">{f.why}</div>
      {f.evidence.map((e, k) => <div key={k}><blockquote>{e.quote}</blockquote><button className="btn small" onClick={() => onDoc({ id: e.docId, quote: e.quote })}>Open source</button></div>)}
      <div className="row" style={{ marginTop: 8 }}>
        {!d ? (<>
          {f.kind !== "duplicate" && <button className="btn small good" onClick={onApprove}>Approve</button>}
          {f.kind === "duplicate" && <button className="btn small good" onClick={onApprove}>Mark reviewed</button>}
          <button className="btn small bad" onClick={onReject}>Reject</button>
        </>) : <button className="btn small" onClick={onUndo}>Undo</button>}
      </div>
    </div>
  );
}

function DocModal({ id, quote, onClose }: { id: string; quote?: string; onClose: () => void }) {
  const doc = getDoc(id);
  if (!doc) return null;
  let body: React.ReactNode = doc.text;
  if (quote) {
    // Find the quote in the original text, tolerating any whitespace differences, and keep line breaks.
    const esc = quote.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const m = new RegExp(esc, "i").exec(doc.text);
    if (m) body = <>{doc.text.slice(0, m.index)}<mark>{m[0]}</mark>{doc.text.slice(m.index + m[0].length)}</>;
  }
  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="meta">{doc.file}{doc.synthetic ? " · added test case" : ""}</span>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        <pre>{body}</pre>
      </div>
    </div>
  );
}
