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
            results[d.id] = j; if (j.error) { failures++; setErr(j.error); }
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
  const groups = [
    { id: "late", title: "Late", items: shown.filter((i) => (i.daysLeft !== null && i.daysLeft < 0)) },
    { id: "soon", title: "Due in the next 7 days", items: shown.filter((i) => i.daysLeft !== null && i.daysLeft >= 0 && i.daysLeft <= 7) },
    { id: "waiting", title: "Clients waiting on us", items: shown.filter((i) => i.daysLeft === null && ["client_request", "promise_by_atliq", "new_lead"].includes(i.type)) },
    { id: "later", title: "Later and opportunities", items: shown.filter((i) => (i.daysLeft !== null && i.daysLeft > 7) || (i.daysLeft === null && !["client_request", "promise_by_atliq", "new_lead"].includes(i.type))) },
  ];
  const doneCount = Object.values(decisions).filter((d) => d.state === "done").length;
  const overdue = visible.filter((i) => (i.daysLeft ?? 0) < 0 || (i.daysLeft === null && i.ageDays > 14)).length;
  const lateCount = visible.filter((i) => i.daysLeft !== null && i.daysLeft < 0).length;
  const soonCount = visible.filter((i) => i.daysLeft !== null && i.daysLeft >= 0 && i.daysLeft <= 7).length;
  const waitingCount = visible.filter((i) => i.daysLeft === null && ["client_request", "promise_by_atliq", "new_lead"].includes(i.type)).length;
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
        <div className="wrap topbar">
          <div className="brand">
            <svg className="mark" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" /><path d="M11 21l6 6 12-14" /></svg>
            <div>
              <h1>PromiseKeeper</h1>
              <p>for AtliQ Technologies</p>
            </div>
          </div>
          <div className="runbox">
            {status?.accessCodeRequired && <input className="code" placeholder="Access code" aria-label="Access code" value={code} onChange={(e) => setCode(e.target.value)} />}
            {progress ? (
              <div className="reading" role="status"><div className="progress"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>Reading {progress.done} of {progress.total}</div>
            ) : (
              <button className="btn primary" onClick={runAI} disabled={!status?.aiEnabled} title={status?.aiEnabled ? "" : "Set ANTHROPIC_API_KEY on the server"}>
                {run ? "Re-read all emails" : "Read all emails"}
              </button>
            )}
            {run && <button className="btn ghost" onClick={exportRun}>Export run</button>}
          </div>
        </div>
      </header>

      <main className="wrap">
        {status && !status.aiEnabled && !run && <div className="notice">Live AI is off because the server has no ANTHROPIC_API_KEY. Add it in Vercel settings, then press Read all emails.</div>}
        {err && <div className="notice">Some documents could not be read: {err}</div>}
        {run && (() => { const bad = Object.values(run.results).filter((r) => r.error); return bad.length ? <div className="notice"><b>{bad.length} of {Object.keys(run.results).length} documents failed in the last run.</b> Error from the AI service: <code>{bad[0].error}</code></div> : null; })()}

        {tab === "brief" && <section className="hero">
          <div className="hero-text">
            <p className="today">{new Date(dataset.asOf + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</p>
            {run ? (
              <h2>AtliQ owes its clients {visible.length} things. <span className="late">{lateCount} are late</span>, <span className="soon">{soonCount} are due this week</span> and {waitingCount} are waiting on a reply.</h2>
            ) : (
              <h2>Every promise AtliQ makes to a client, read from the inbox and kept in one place.</h2>
            )}
            <p className="baseline">Before PromiseKeeper, AtliQ kept {answerKey.baseline.met} of {answerKey.baseline.due} client commitments on time.</p>
          </div>
          <dl className="ledger">
            <div><dt>Late</dt><dd className="late">{lateCount}</dd></div>
            <div><dt>Due in 7 days</dt><dd className="soon">{soonCount}</dd></div>
            <div><dt>Deal value with an open item</dt><dd>${Math.round(valueAtRisk / 1000)}k</dd></div>
            <div><dt>Waiting on a reply</dt><dd>{waitingCount}</dd></div>
            <div><dt>Marked done today</dt><dd className="ok">{doneCount}</dd></div>
          </dl>
        </section>}
        {run && <p className="runline">Last read {new Date(run.ranAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} from {loadedFrom}. {analysis.stats.docs} documents, {tokens.toLocaleString()} tokens, under ${Math.max(0.01, costUpper).toFixed(2)}. Models: {status?.filterModel ?? "claude-haiku-5-5"} to screen, {status?.extractionModel ?? "claude-sonnet-5-5"} to read.</p>}

        <nav className="tabs" style={tab === "brief" ? undefined : { marginTop: 28 }}>
          {([["brief", "Today's brief", visible.length], ["fixes", "CRM fixes", fixesOpen], ["unsure", "Needs a human", analysis.unsure.length], ["evals", "Evals", null], ["audit", "Audit log", audit.length], ["data", "Source data", null]] as [Tab, string, number | null][]).map(([t, l, n]) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{l}{n !== null && <span className="count">{n}</span>}</button>
          ))}
        </nav>

        {!run && <div className="empty">Nothing read yet. Press <b>Read all emails</b> to go through all {dataset.docs.length} emails and notes. It takes about a minute.</div>}

        {run && tab === "brief" && (
          <section>
            <div className="people" role="tablist" aria-label="Whose brief">
              {["All", ...SELLERS, "Unowned"].map((p) => {
                const n = p === "All" ? visible.length : p === "Unowned" ? visible.filter((i) => !ownerOf(i)).length : visible.filter((i) => ownerOf(i) === p).length;
                return <button key={p} role="tab" aria-selected={seller === p} className={`person ${seller === p ? "on" : ""}`} onClick={() => setSeller(p)}>
                  {p !== "All" && p !== "Unowned" && <span className="avatar" aria-hidden="true">{p[0]}</span>}
                  <span>{p === "All" ? "Whole team" : p === "Unowned" ? "No owner" : p}</span><span className="n">{n}</span>
                </button>;
              })}
            </div>
            {seller !== "All" && (
              <div className="morning">
                <div>
                  <h3>{seller === "Unowned" ? "Nobody owns these yet" : `${seller}'s top ${Math.min(10, mine.length)} for today`}</h3>
                  {summary[seller] ? <p>{summary[seller]}</p> : mine.length === 0 ? <p>Nothing owed today.</p> : <p className="hint">{seller === "Unowned" ? "Assign each one so it lands in someone's brief." : "Capped at 10 so the list stays readable on a phone."}</p>}
                </div>
                {status?.aiEnabled && mine.length > 0 && seller !== "Unowned" && <button className="btn ghost" onClick={() => summarise(seller, mine)}>Summarise my day</button>}
              </div>
            )}
            {groups.map((g) => g.items.length > 0 && (
              <div key={g.id} className={`group ${g.id}`}>
                <h3 className="group-title">{g.title}<span>{g.items.length}</span></h3>
                {g.items.map((i) => <ItemCard key={i.key} i={i} rank={shown.indexOf(i) + 1} owner={ownerOf(i)} onDoc={setViewDoc}
                  onDone={() => decide(i.key, { state: "done" }, `${i.account}: ${i.summary}`, "Marked done")}
                  onSnooze={() => decide(i.key, { state: "snoozed" }, `${i.account}: ${i.summary}`, "Snoozed")}
                  onReassign={(to) => decide(i.key, { state: "reassigned", to }, `${i.account}: ${i.summary}`, `Reassigned to ${to}`)} />)}
              </div>
            ))}
            {seller !== "All" && mine.length > 10 && <p className="hint">{mine.length - 10} more are in the whole-team view.</p>}
            <details className="how"><summary>How the order is decided</summary>
              <p>Plain rules, not AI. Urgency counts most: late items, then items due within 3 days, 7 days, 14 days. Undated requests rise the longer a client has waited. Deal value adds weight (up to $80k). Client deadlines, requests and our own promises outrank cross-sell ideas.</p>
              <p>Unclear accounts and contacts who asked not to be contacted never appear here. Items the AI is unsure about carry a &ldquo;please check&rdquo; label. The same ask repeated across threads or internal notes is shown once. Items made obsolete by a later deal change are hidden, and CRM activity after a due date marks the item as done.</p>
            </details>
          </section>
        )}

        {run && tab === "fixes" && (
          <section>
            <p className="meta">Nothing here changes the CRM until you approve it. Approved changes appear in the Source data tab and in the audit log.</p>
            {analysis.fixes.length === 0 && <div className="empty">No CRM fixes suggested.</div>}
            {analysis.fixes.map((f) => <FixCard key={f.id} f={f} d={decisions[f.id]} onDoc={setViewDoc}
              onApprove={() => decide(f.id, { state: "approved" }, `${f.account} ${f.field}`, `${f.from} → ${f.to}`)}
              onReject={() => decide(f.id, { state: "rejected" }, `${f.account} ${f.field}`, `Rejected: ${f.from} → ${f.to}`)}
              onUndo={() => undo(f.id, `${f.account} ${f.field}`)} />)}
          </section>
        )}

        {run && tab === "unsure" && (
          <section>
            <p className="meta">PromiseKeeper does not guess about these. None of them reach the brief or the CRM until someone decides.</p>
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
      <footer><p>PromiseKeeper never emails a client and never changes the CRM without your approval.</p><p>Capstone 1 prototype by Kokku Naga Venkata Durga Prasad. All data is synthetic.</p></footer>
    </>
  );
}

function stamp(i: BriefItem) {
  if (i.daysLeft === null) return { cls: i.ageDays > 14 ? "late" : "wait", big: i.ageDays > 0 ? `${i.ageDays}` : "new", small: i.ageDays > 0 ? "days waiting" : "no date" };
  if (i.daysLeft < 0) return { cls: "late", big: fmtDate(i.due_date), small: `${-i.daysLeft} ${-i.daysLeft === 1 ? "day" : "days"} late` };
  if (i.daysLeft === 0) return { cls: "soon", big: fmtDate(i.due_date), small: "due today" };
  return { cls: i.daysLeft <= 7 ? "soon" : "later", big: fmtDate(i.due_date), small: `${i.daysLeft} ${i.daysLeft === 1 ? "day" : "days"} left` };
}

function ItemCard({ i, rank, owner, onDoc, onDone, onSnooze, onReassign }: { i: BriefItem; rank: number; owner: string | null; onDoc: (d: { id: string; quote?: string }) => void; onDone: () => void; onSnooze: () => void; onReassign: (to: string) => void }) {
  const doc = getDoc(i.docId);
  const st = stamp(i);
  return (
    <article className="item">
      <div className={`stamp ${st.cls}`} aria-label={`${st.big} ${st.small}`}><b>{st.big}</b><span>{st.small}</span></div>
      <div className="item-body">
        <div className="item-head">
          <span className="rank" title="Position in the ranking">{rank}</span>
          <span className="kind">{TYPE_LABEL[i.type]}</span>
          {i.match.kind === "none" && <span className="flag amber">Not in CRM</span>}
          {i.confidence === "low" && <span className="flag amber">AI unsure, please check</span>}
          {i.match.candidates.length > 1 && <span className="flag grey">Duplicate CRM records</span>}
        </div>
        <h4>{i.account}{i.crmId && <small>{i.crmId}</small>}</h4>
        <p className="what">{i.summary}</p>
        <blockquote><span>{i.quote}</span></blockquote>
        <div className="item-foot">
          <span className="who"><span className="avatar sm" aria-hidden="true">{owner ? owner[0] : "?"}</span>{owner ?? "No owner"}</span>
          {i.value ? <span className="val">${i.value.toLocaleString()}</span> : null}
          <button className="src" onClick={() => onDoc({ id: i.docId, quote: i.quote })}>{doc?.kind === "note" ? "Meeting note" : "Email"}, {fmtDate(i.docDate)}{i.alsoIn.length > 0 ? ` (+${i.alsoIn.length} more)` : ""}</button>
          <span className="why" title="Why it ranks here">{i.reason}</span>
        </div>
        <div className="actions">
          <button className="btn done" onClick={onDone}>Mark done</button>
          <button className="btn ghost" onClick={onSnooze}>Snooze</button>
          <select defaultValue="" onChange={(e) => e.target.value && onReassign(e.target.value)} aria-label="Reassign to">
            <option value="" disabled>Reassign</option>
            {["Bhavin", "Dhaval", "Karandeep", "Jay", "Pranav", "Ayush"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
      </div>
    </article>
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
