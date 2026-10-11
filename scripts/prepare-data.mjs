// Builds the dataset bundle the app uses.
// 1. Reads the provided dataset (data/raw) and our labelled additions (data/additions).
// 2. Strips the editorial notes ("*(...)*" lines) so the AI never sees ground truth.
// 3. Writes clean copies to data/clean (for transparency) and lib/generated/dataset.json.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RAW = path.join(root, "data/raw");
const ADD = path.join(root, "data/additions");
const CLEAN = path.join(root, "data/clean");
const OUT = path.join(root, "lib/generated/dataset.json");

// Editorial notes are italic parentheticals: "*(No reply sent ...)*", inline or on their own line.
const EDITORIAL = /\*\([^*]*?\)\*/g;

function clean(text) {
  const notes = [];
  const stripped = text.replace(EDITORIAL, (m) => {
    notes.push(m.slice(2, -2));
    return "";
  });
  const tidy = stripped
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: tidy + "\n", notes };
}

function meta(id, text) {
  const date = (text.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || id.replace(/^x_/, "").slice(0, 10);
  const title = (text.match(/^#\s+(.+)$/m) || [])[1] || id;
  const emails = [...new Set((text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).map((e) => e.toLowerCase()))];
  return { date, title, emails };
}

const docs = [];
for (const [base, synthetic] of [[RAW, false], [ADD, true]]) {
  for (const kind of ["emails", "meeting_notes"]) {
    const dir = path.join(base, kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const { text, notes } = clean(raw);
      const id = f.replace(/\.md$/, "");
      fs.mkdirSync(path.join(CLEAN, kind), { recursive: true });
      fs.writeFileSync(path.join(CLEAN, kind, f), text);
      docs.push({ id, kind: kind === "emails" ? "email" : "note", file: `${kind}/${f}`, synthetic, ...meta(id, text), text, editorialNotesRemoved: notes.length });
    }
  }
}

// CRM CSV (handles quoted fields)
function parseCSV(s) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [h, ...rest] = rows.filter((r) => r.length > 1);
  return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
}
const crm = parseCSV(fs.readFileSync(path.join(RAW, "crm_export.csv"), "utf8")).map((r) => ({
  ...r, est_value_usd: r.est_value_usd ? Number(r.est_value_usd) : null,
}));
fs.copyFileSync(path.join(RAW, "crm_export.csv"), path.join(CLEAN, "crm_export.csv"));

const team = [
  { name: "Bhavin", role: "Founder (seller)", email: "bhavin@atliq.com", seller: true },
  { name: "Dhaval", role: "Founder (seller)", email: "dhaval@atliq.com", seller: true },
  { name: "Karandeep", role: "CEO (seller)", email: "karandeep@atliq.com", seller: true },
  { name: "Jay", role: "Sales executive", email: "jay@atliq.com", seller: true },
  { name: "Pranav", role: "CTO (pre-sales)", email: "pranav@atliq.com", seller: false },
  { name: "Ayush", role: "AI Product Manager (pre-sales)", email: "ayush@atliq.com", seller: false },
];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ asOf: "2026-07-10", team, crm, docs }, null, 1));
const removed = docs.reduce((a, d) => a + d.editorialNotesRemoved, 0);
console.log(`docs: ${docs.length} (${docs.filter((d) => d.synthetic).length} added test cases), CRM rows: ${crm.length}, editorial notes removed: ${removed}`);
