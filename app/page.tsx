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

  const gatesPassed = evals.rows.filter((r) => r.pass).length;
  const safetyPassed = evals.safety.filter((r) => r.pass).length;
  const failedDocs = run ? Object.values(run.results).filter((r) => r.error) : [];
  const accountsAtRisk = new Set(visible.filter((i) => i.value && i.crmId && (i.daysLeft === null ? i.ageDays > 7 : i.daysLeft <= 21)).map((i) => i.crmId)).size;
  const longestWait = Math.max(0, ...visible.filter((i) => i.daysLeft === null && ["client_request", "promise_by_atliq", "new_lead"].includes(i.type)).map((i) => i.ageDays));
  const nextDue = visible.filter((i) => i.daysLeft !== null && i.daysLeft >= 0).sort((a, b) => a.daysLeft! - b.daysLeft!)[0];
  const approvedCount = analysis.fixes.filter((f) => decisions[f.id]?.state === "approved").length;
  const asOfLong = new Date(dataset.asOf + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const goTo = (t: Tab, anchor?: string) => {
    setTab(t);
    if (anchor) { setSeller("All"); setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60); }
    else window.scrollTo({ top: 0 });
  };

  const NAV: { t: Tab; label: string; icon: IconName; n: number | null; tone?: string }[] = [
    { t: "brief", label: "Today's brief", icon: "inbox", n: run ? visible.length : null },
    { t: "fixes", label: "CRM fixes", icon: "database", n: run ? fixesOpen : null },
    { t: "unsure", label: "Needs a human", icon: "help", n: run ? analysis.unsure.length : null, tone: "amber" },
    { t: "evals", label: "Evals", icon: "gauge", n: run ? null : null },
    { t: "audit", label: "Audit log", icon: "list", n: audit.length || null },
    { t: "data", label: "Source data", icon: "file", n: null },
  ];

  const HEAD: Record<Tab, { title: string; lede: React.ReactNode }> = {
    brief: { title: "Today's brief", lede: <>Every promise, client deadline and buying signal found in {dataset.docs.length} emails and meeting notes, ranked by what needs attention first. Each one shows the client&rsquo;s own words and a link to the source.</> },
    fixes: { title: "CRM fixes", lede: <>Corrections the CRM is missing, each backed by a quote. Nothing changes until someone approves it. {approvedCount > 0 && <>{approvedCount} approved so far.</>}</> },
    unsure: { title: "Needs a human", lede: <>Things PromiseKeeper will not guess about: unclear contacts, conflicting dates and suspicious instructions inside emails. None of them reach the brief or the CRM until a person decides.</> },
    evals: { title: "Evals", lede: <>This run measured against a hand-labelled answer key ({answerKey.commitments.length} commitments, {answerKey.missing_leads.length} missing leads, {answerKey.signals.length} signals) that the AI never sees. Baseline: AtliQ kept {answerKey.baseline.met} of {answerKey.baseline.due} commitments on time ({Math.round(answerKey.baseline.rate * 100)}%).</> },
    audit: { title: "Audit log", lede: <>Every AI run and every human decision, newest first. Stored in this browser for the prototype.</> },
    data: { title: "Source data", lede: <>The CRM with approved changes highlighted, and every document exactly as the AI reads it (editorial notes removed).</> },
  };

  const kpis: { id: string; label: string; value: string; sub: string; tone?: string; onClick: () => void }[] = [
    { id: "late", label: "Late", value: run ? String(lateCount) : "–", sub: run ? `of ${visible.length} open items` : "no run yet", tone: "late", onClick: () => goTo("brief", "g-late") },
    { id: "soon", label: "Due in 7 days", value: run ? String(soonCount) : "–", sub: nextDue ? `next due ${fmtDate(nextDue.due_date)}, ${nextDue.account}` : "nothing due", tone: "soon", onClick: () => goTo("brief", "g-soon") },
    { id: "waiting", label: "Waiting on a reply", value: run ? String(waitingCount) : "–", sub: longestWait ? `longest wait ${longestWait} days` : "nobody waiting", onClick: () => goTo("brief", "g-waiting") },
    { id: "value", label: "Pipeline at stake", value: run ? `$${Math.round(valueAtRisk / 1000)}k` : "–", sub: `${accountsAtRisk} accounts`, onClick: () => goTo("brief") },
    { id: "fixes", label: "CRM fixes to review", value: run ? String(fixesOpen) : "–", sub: `${approvedCount} approved, ${doneCount} items done`, onClick: () => goTo("fixes") },
    { id: "evals", label: "Eval gates passing", value: run ? `${gatesPassed}/${evals.rows.length}` : "–", sub: `safety tests ${safetyPassed}/${evals.safety.length}`, tone: run && gatesPassed === evals.rows.length ? "ok" : undefined, onClick: () => goTo("evals") },
  ];

  const runPanel = (
    <section className="runpanel" aria-label="AI run">
      <div className="runpanel-head">
        <span className={`dot ${progress ? "busy" : failedDocs.length ? "warn" : run ? "ok" : ""}`} aria-hidden="true" />
        <h2>{progress ? "Reading documents" : run ? "Last AI run" : "No AI run yet"}</h2>
      </div>
      {progress ? (
        <div role="status">
          <div className="progress"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
          <p className="runmeta">{progress.done} of {progress.total} documents</p>
        </div>
      ) : run ? (
        <dl className="runfacts">
          <div><dt>When</dt><dd>{new Date(run.ranAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</dd></div>
          <div><dt>Source</dt><dd>{loadedFrom}</dd></div>
          <div><dt>Documents</dt><dd>{analysis.stats.docs}{failedDocs.length ? `, ${failedDocs.length} failed` : ""}</dd></div>
          <div><dt>Cost</dt><dd>under ${Math.max(0.01, costUpper).toFixed(2)}</dd></div>
          <div><dt>Models</dt><dd>{modelName(status?.filterModel ?? "claude-haiku-5-5")} screens, {modelName(status?.extractionModel ?? "claude-sonnet-5-5")} reads</dd></div>
        </dl>
      ) : <p className="runmeta">Read all {dataset.docs.length} emails and notes. Takes about a minute.</p>}
      {!progress && <>
        {status?.accessCodeRequired && <input className="code" placeholder="Access code" aria-label="Access code" value={code} onChange={(e) => setCode(e.target.value)} />}
        <button className="btn run" onClick={runAI} disabled={!status?.aiEnabled} title={status?.aiEnabled ? "Sends each document to Claude and rebuilds the brief" : "Set ANTHROPIC_API_KEY on the server"}>
          <Icon name="refresh" />{run ? "Run again" : "Read all emails"}
        </button>
        {run && <button className="linkbtn" onClick={exportRun}><Icon name="download" />Download results (JSON)</button>}
      </>}
    </section>
  );

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <svg className="mark" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" /><path d="M11 21l6 6 12-14" /></svg>
          <div><h1>PromiseKeeper</h1><p>AtliQ Technologies</p></div>
        </div>
        <nav className="nav" aria-label="Sections">
          {NAV.map((n) => (
            <button key={n.t} className={tab === n.t ? "on" : ""} aria-current={tab === n.t ? "page" : undefined} onClick={() => goTo(n.t)}>
              <Icon name={n.icon} /><span>{n.label}</span>
              {n.t === "evals" && run ? <span className={`n ${gatesPassed === evals.rows.length ? "good" : ""}`}>{gatesPassed}/{evals.rows.length}</span> : n.n !== null && n.n > 0 ? <span className={`n ${n.tone ?? ""}`}>{n.n}</span> : null}
            </button>
          ))}
        </nav>
        <div className="side-run">{runPanel}</div>
        <p className="side-note"><Icon name="shield" />Never emails a client. Never changes the CRM without approval.</p>
      </aside>

      <div className="main">
        <header className="pagehead">
          <p className="eyebrow">{asOfLong}</p>
          <h2>{HEAD[tab].title}</h2>
          <p className="lede">{HEAD[tab].lede}</p>
        </header>

        <section className="kpis" aria-label="Key numbers">
          {kpis.map((k) => (
            <button key={k.id} className={`kpi ${k.tone ?? ""} ${(tab === "fixes" && k.id === "fixes") || (tab === "evals" && k.id === "evals") ? "on" : ""}`} onClick={k.onClick}>
              <span className="kpi-label">{k.label}</span>
              <span className="kpi-value">{k.value}</span>
              <span className="kpi-sub">{k.sub}</span>
            </button>
          ))}
        </section>
        {run && <p className="baseline">Before PromiseKeeper, AtliQ kept <b>{answerKey.baseline.met} of {answerKey.baseline.due}</b> client commitments on time. Missed commitments caught by this run: <b>{evals.rows[1]?.value}</b>.</p>}

        {status && !status.aiEnabled && !run && <div className="notice">Live AI is off because the server has no ANTHROPIC_API_KEY. Add it in Vercel settings, then press Read all emails.</div>}
        {err && <div className="notice">Some documents could not be read: {err}</div>}
        {failedDocs.length > 0 && <div className="notice"><b>{failedDocs.length} of {Object.keys(run!.results).length} documents failed in the last run.</b> Error from the AI service: <code>{failedDocs[0].error}</code></div>}

        {!run && tab !== "audit" && tab !== "data" && <div className="empty">Nothing read yet. Press <b>Read all emails</b> in the AI run panel to go through all {dataset.docs.length} emails and notes.</div>}

        {run && tab === "brief" && (
          <section>
            <div className="toolbar">
              <div className="people" role="tablist" aria-label="Whose brief">
                {["All", ...SELLERS, "Unowned"].map((p) => {
                  const n = p === "All" ? visible.length : p === "Unowned" ? visible.filter((i) => !ownerOf(i)).length : visible.filter((i) => ownerOf(i) === p).length;
                  return <button key={p} role="tab" aria-selected={seller === p} className={`person ${seller === p ? "on" : ""}`} onClick={() => setSeller(p)}>
                    {p !== "All" && p !== "Unowned" && <span className="avatar" aria-hidden="true">{p[0]}</span>}
                    <span>{p === "All" ? "Whole team" : p === "Unowned" ? "No owner" : p}</span><span className="n">{n}</span>
                  </button>;
                })}
              </div>
              <div className="jump" aria-label="Jump to">
                {groups.map((g) => g.items.length > 0 && <a key={g.id} href={`#g-${g.id}`} className={g.id}>{g.title.replace("Due in the next 7 days", "This week").replace("Clients waiting on us", "Waiting").replace("Later and opportunities", "Later")} <b>{g.items.length}</b></a>)}
              </div>
            </div>
            {seller !== "All" && (
              <div className="morning">
                <div>
                  <h3>{seller === "Unowned" ? "Nobody owns these yet" : `${seller}'s top ${Math.min(10, mine.length)} for today`}</h3>
                  {summary[seller] ? <p>{summary[seller]}</p> : mine.length === 0 ? <p>Nothing owed today.</p> : <p className="hint">{seller === "Unowned" ? "Assign each one so it lands in someone's brief." : "Capped at 10 so the list stays readable on a phone."}</p>}
                </div>
                {status?.aiEnabled && mine.length > 0 && seller !== "Unowned" && <button className="btn" onClick={() => summarise(seller, mine)}>Summarise my day</button>}
              </div>
            )}
            {groups.map((g) => g.items.length > 0 && (
              <div key={g.id} id={`g-${g.id}`} className={`group ${g.id}`}>
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
            {analysis.fixes.length === 0 && <div className="empty">No CRM fixes suggested.</div>}
            {(() => {
              const order: CrmFix["kind"][] = ["do_not_contact", "new_record", "status", "next_followup", "last_contact", "owner", "value", "duplicate"];
              return order.map((k) => {
                const list = analysis.fixes.filter((f) => f.kind === k);
                if (!list.length) return null;
                return <div key={k} className="group">
                  <h3 className="group-title">{FIX_LABEL[k]}<span>{list.filter((f) => !decisions[f.id]).length} to review of {list.length}</span></h3>
                  {list.map((f) => <FixCard key={f.id} f={f} d={decisions[f.id]} onDoc={setViewDoc}
                    onApprove={() => decide(f.id, { state: "approved" }, `${f.account} ${f.field}`, `${f.from} → ${f.to}`)}
                    onReject={() => decide(f.id, { state: "rejected" }, `${f.account} ${f.field}`, `Rejected: ${f.from} → ${f.to}`)}
                    onUndo={() => undo(f.id, `${f.account} ${f.field}`)} />)}
                </div>;
              });
            })()}
          </section>
        )}

        {run && tab === "unsure" && (
          <section>
            {analysis.unsure.length === 0 && <div className="empty">Nothing unsure.</div>}
            {analysis.unsure.map((u) => (
              <div className="card" key={u.id}>
                <div className="row"><span className={`pill ${u.kind === "suspicious" ? "red" : u.kind === "dropped" ? "grey" : "amber"}`}>{({ ambiguous: "Ambiguous account", low_confidence: "Low confidence", suspicious: "Suspicious", conflict: "Conflicting dates", dropped: "Dropped by guardrail" } as any)[u.kind]}</span><span className="meta">{getDoc(u.docId)?.title}</span></div>
                <h3>{u.title}</h3>
                <p className="meta" style={{ margin: 0 }}>{u.detail}</p>
                {u.quote && <blockquote><span>{u.quote}</span></blockquote>}
                <button className="btn small" onClick={() => setViewDoc({ id: u.docId, quote: u.quote })}>Open source</button>
              </div>
            ))}
          </section>
        )}

        {run && tab === "evals" && (
          <section>
            <div className="scorecards">
              {evals.rows.map((r) => (
                <div key={r.name} className={`score ${r.pass ? "pass" : "fail"}`}>
                  <span className="score-badge">{r.pass ? "Pass" : "Below target"}</span>
                  <p className="score-name">{r.name}</p>
                  <p className="score-value">{r.value}</p>
                  <p className="score-target">Target: {r.target}</p>
                  {r.detail && <p className="score-detail">{r.detail}</p>}
                </div>
              ))}
            </div>
            <h3 className="sub">Safety tests (our added test cases)</h3>
            <div className="tablewrap"><table><thead><tr><th>Test</th><th>Result</th><th>Expected</th><th>Pass</th></tr></thead><tbody>
              {evals.safety.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.value}</td><td>{r.target}</td><td>{r.pass ? <span className="pill green">Pass</span> : <span className="pill red">Fail</span>}</td></tr>)}
            </tbody></table></div>
            {evals.notFound.length > 0 && (<>
              <h3 className="sub">Labelled items not found in this run ({evals.notFound.length})</h3>
              <div className="tablewrap"><table><thead><tr><th>Account</th><th>Item</th><th>Status</th><th>Source</th></tr></thead><tbody>
                {evals.notFound.map((k: any) => <tr key={k.id}><td>{k.account}</td><td>{k.summary}</td><td>{k.status}</td><td><a href="#" onClick={(e) => { e.preventDefault(); setViewDoc({ id: k.doc }); }}>{k.doc}</a></td></tr>)}
              </tbody></table></div></>)}
            {evals.unsupported.length > 0 && (<>
              <h3 className="sub">Brief items not in the answer key ({evals.unsupported.length}), for review by hand</h3>
              <div className="tablewrap"><table><thead><tr><th>Account</th><th>Item</th><th>Type</th><th>Source</th></tr></thead><tbody>
                {evals.unsupported.map((i) => <tr key={i.key}><td>{i.account}</td><td>{i.summary}</td><td>{TYPE_LABEL[i.type]}</td><td><a href="#" onClick={(e) => { e.preventDefault(); setViewDoc({ id: i.docId, quote: i.quote }); }}>{i.docId}</a></td></tr>)}
              </tbody></table></div></>)}
          </section>
        )}

        {tab === "audit" && (
          <section>
            {audit.length === 0 ? <div className="empty">No actions yet. Mark an item done or approve a CRM fix and it appears here.</div> : (
              <div className="tablewrap"><table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>
                {audit.map((a, k) => <tr key={k}><td style={{ whiteSpace: "nowrap" }}>{new Date(a.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td><td><span className="pill grey">{a.action.replace("_", " ")}</span></td><td>{a.target}</td><td>{a.detail}</td></tr>)}
              </tbody></table></div>)}
          </section>
        )}

        {tab === "data" && (
          <section>
            <h3 className="sub" style={{ marginTop: 0 }}>CRM ({crmView.length} records)</h3>
            <div className="tablewrap" style={{ maxHeight: 420 }}><table><thead><tr>{["lead_id", "company", "contact_name", "status", "est_value_usd", "owner", "last_contact_date", "next_followup_date"].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>
              {crmView.map((r) => <tr key={r.lead_id}>{(["lead_id", "company", "contact_name", "status", "est_value_usd", "owner", "last_contact_date", "next_followup_date"] as const).map((h) => <td key={h} className={r._changed.includes(h) ? "changed" : ""}>{String(r[h] ?? "")}</td>)}</tr>)}
            </tbody></table></div>
            <h3 className="sub">Documents the AI reads ({dataset.docs.length})</h3>
            <div className="doclist">
              {dataset.docs.map((d) => (
                <button key={d.id} className="docrow" onClick={() => setViewDoc({ id: d.id })}>
                  <span className="docdate">{fmtDate(d.date)}</span>
                  <span className="doctitle">{d.title}</span>
                  {d.synthetic && <span className="pill amber">added test case</span>}
                  {run?.results[d.id] && <span className="docn">{run.results[d.id].items.length} items</span>}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="mobile-run">{runPanel}</div>
        <footer><p>Capstone 1 prototype by Kokku Naga Venkata Durga Prasad. All data is synthetic.</p></footer>
      </div>

      {viewDoc && <DocModal id={viewDoc.id} quote={viewDoc.quote} onClose={() => setViewDoc(null)} />}
    </div>
  );
}

const FIX_LABEL: Record<CrmFix["kind"], string> = { new_record: "Add missing lead", status: "Fix status", last_contact: "Update last contact", next_followup: "Set next follow-up", owner: "Assign owner", value: "Add deal value", duplicate: "Possible duplicate", do_not_contact: "Do not contact" };

const modelName = (id: string) => id.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());

type IconName = "inbox" | "database" | "help" | "gauge" | "list" | "file" | "refresh" | "download" | "shield";
const ICONS: Record<IconName, string> = {
  inbox: "M4 13h4l2 3h4l2-3h4M4 13l2.5-7h11L20 13v6H4z",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2M12 17h.01",
  gauge: "M4 18a8 8 0 1116 0M12 18l4-6",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  file: "M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6",
  refresh: "M20 12a8 8 0 01-14.3 4.9M4 12A8 8 0 0118.3 7.1M18 3v4.5h-4.5M6 21v-4.5h4.5",
  download: "M12 4v11m0 0l-4-4m4 4l4-4M5 20h14",
  shield: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z",
};
function Icon({ name }: { name: IconName }) {
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name]} /></svg>;
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
  return (
    <article className={`card fix ${d ? "decided " + d.state : ""}`}>
      <div className="fix-main">
        <div className="row">
          <span className="meta">{f.crmId ?? "New record"}</span>
          {d && <span className={`pill ${d.state === "approved" ? "green" : "grey"}`}>{d.state === "approved" ? "Approved" : "Rejected"}</span>}
        </div>
        <h3>{f.account}</h3>
        <div className="diff">
          <span className="field">{f.field.replace(/_/g, " ")}</span>
          {f.kind !== "new_record" && <><span className="from">{f.from || "empty"}</span>
          <span className="arrow" aria-label="becomes">→</span></>}
          <span className="to">{f.to}</span>
        </div>
        <p className="meta why-fix">{f.why}</p>
        {f.evidence.map((e, k) => (
          <div key={k} className="evidence">
            <blockquote><span>{e.quote}</span></blockquote>
            <button className="src" onClick={() => onDoc({ id: e.docId, quote: e.quote })}>{getDoc(e.docId)?.kind === "note" ? "Meeting note" : "Email"}, {fmtDate(getDoc(e.docId)?.date ?? null)}</button>
          </div>
        ))}
      </div>
      <div className="fix-actions">
        {!d ? (<>
          <button className="btn good" onClick={onApprove}>{f.kind === "duplicate" ? "Mark reviewed" : "Approve"}</button>
          <button className="btn bad" onClick={onReject}>Reject</button>
        </>) : <button className="btn" onClick={onUndo}>Undo</button>}
      </div>
    </article>
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
