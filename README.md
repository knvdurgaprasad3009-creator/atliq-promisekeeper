# AtliQ PromiseKeeper — "Every client promise, kept."

Capstone 1 prototype (Codebasics AI PM Cohort) · Kokku Naga Venkata Durga Prasad

> **Capstone submission:** all seven deliverables (worksheet, Miro map, PRD, cost estimate, prototype, presentation, demo video) are listed in **[deliverables/](deliverables/README.md)**. Live app: [atliq-promisekeeper.vercel.app](https://atliq-promisekeeper.vercel.app)

AtliQ's founder-sellers don't have a lead problem; they have a **memory problem**. Promises made in email, client deadlines and buying signals die in inboxes. In the dataset, only **12 of 37** commitments due by 10 July 2026 were met (32%), and **$423k** of open pipeline has an unanswered client or a deadline within ~3 weeks.

PromiseKeeper reads the emails, meeting notes and CRM, extracts every commitment, client deadline and buying signal **with a verbatim quote from its source**, and gives each seller a ranked daily brief. It **proposes** CRM fixes for one-click approval and **never contacts clients or edits the CRM on its own**.

## What you can do in the app

The left sidebar holds the sections and an **AI run** panel (last run time, documents, cost, models, **Run again** and **Download results**). A strip of key numbers (late, due in 7 days, waiting on a reply, pipeline at stake, CRM fixes to review, eval gates passing) stays at the top of every section; each number is clickable. On a phone the sections become a scrolling top bar and the AI run panel moves to the end of the page.

| Tab | What it shows |
|---|---|
| **Today's brief** | Ranked items per seller (Team view, Bhavin, Dhaval, Karandeep, Jay, Unowned). Each card: type, account, what is owed, due date / days left, owner, value, *why it ranks here*, the source quote and a link to the source. Done / Snooze / Reassign. Personal briefs are capped at 10 items; "Summarise my day" writes a two-line summary from those items only. |
| **CRM fixes** | Missing leads, wrong statuses (e.g. "Lost" deals that came back), last-contact and follow-up dates, owners, values, possible duplicates — each with evidence. Approve / Reject. Nothing changes until a person approves. |
| **Needs a human** | Things it will not guess about: ambiguous contacts, low-confidence items, conflicting dates, suspicious instructions inside emails, and AI items dropped by the guardrails. |
| **Evals** | Launch gates from the PRD, measured against a hand-labelled answer key: recall, precision, citation faithfulness, leads, signals, plus five safety tests. Lists every labelled item the AI missed. |
| **Audit log** | Every AI run and every human decision. |
| **Source data** | The CRM (approved changes highlighted) and every document exactly as the AI sees it. |

## Architecture (what is AI and what is not)

```
Browser (Next.js page)
  └─ for each of 55 documents → POST /api/extract {docId}      (4 in parallel)
        server: injection tripwire (regex, no AI)
                → Claude Haiku 5.5: is this a sales/client document?        (cheap filter)
                → Claude Sonnet 5.5: extract items as JSON via a forced tool call
                → guardrails: schema check, quote must exist verbatim in the source,
                  values must appear in the text, stage changes blocked in suspicious docs
  └─ rules engine (lib/rules.ts, no AI): account matching, dates/days left, owners,
     ranking, CRM-fix proposals, conflict detection, do-not-contact suppression
  └─ evals (lib/evals.ts): compares the run with data/answer_key.json
```

* **AI reads; rules decide.** The model only reads text and returns structured items. Ranking, matching, dates and CRM proposals are deterministic code you can read in `lib/rules.ts`.
* **The client sends only a document id.** The server loads the text itself, so nobody can push arbitrary prompts through the API key.
* **No database.** Results, decisions and the audit log are kept in the browser (localStorage) for the prototype. Production would use Postgres (see the PRD and cost estimate).

## Guardrails (from the Step 2 board and the PRD)

1. **No quote, no item:** every item must carry an exact quote found in the source; anything else is dropped and shown under "Needs a human".
2. **Never guesses identity:** ambiguous contacts (e.g. three different Kulkarnis) go to the Unsure list.
3. **Never acts:** there is no code path that sends an email or writes to a real CRM. CRM changes are proposals until approved.
4. **Emails are data, not instructions:** a regex tripwire plus the model flag suspicious instructions; stage-change items from such documents are blocked.
5. **Respects opt-outs:** a "please stop" email suppresses every follow-up for that account.
6. **Never invents dates or values:** invalid dates are removed; a value must appear in the source text.
7. **Visible ranking, capped brief:** the score formula is shown in the app; personal briefs show at most 10 items.

## Dataset and what we added (see also `data/DATA_ADDITIONS.md`)

* `data/raw/` — the provided dataset, untouched (34 emails, 16 meeting notes, 40 CRM rows, README).
* `data/clean/` — generated by `npm run prepare-data` (not committed): copies with the **editorial notes removed** (the italic "*(No reply sent…)*" lines). These notes reveal what happened next, so the AI must never see them. 42 notes removed.
* `data/additions/emails/x_*.md` — **5 test cases we wrote** (clearly marked "ADDED TEST CASE"): prompt injection, an ambiguous sender, an opt-out, a conflicting date and a relative date.
* `data/answer_key.json` — **our hand-labelled ground truth** built from the editorial notes: 49 commitments (12 met, 25 missed, 12 still open), 5 missing leads, 9 signals, expected CRM fixes and expected safety behaviour. It is used only by the Evals tab and is never sent to the model.

The app treats **10 July 2026** as "today" (configurable in `scripts/prepare-data.mjs`).

## Run it locally

Requires Node.js 18+ and an Anthropic API key.

```bash
npm install
cp .env.example .env.local        # then put your key in ANTHROPIC_API_KEY
npm run prepare-data              # only needed if you change data/raw or data/additions
npm run dev                       # open http://localhost:3000 and press "Read all emails"
npm test                          # unit tests for guardrails and the rules engine
```

A full run reads 55 documents (roughly 150–250k tokens) and costs about **$0.50–1.00** with Sonnet 5.5 + Haiku 5.5 at list prices. The daily production estimate is in the Step 4 cost workbook.

## Deploy to Vercel (free tier)

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New → Project → Import** the repository. Framework: Next.js (auto-detected). No build settings to change.
3. **Settings → Environment Variables:**
   * `ANTHROPIC_API_KEY` — your key (required for live AI).
   * `ACCESS_CODE` — optional but recommended: anyone pressing "Run again" on the public link must type this code, so strangers cannot spend your credits.
4. Deploy. Open the URL and press **Read all emails** in the AI run panel.

### Show results without spending credits (recommended before submitting)

After one good run, press **Download results (JSON)** in the AI run panel (downloads `run.json`), put it at `public/cache/run.json`, commit and redeploy. Visitors then see that run immediately; the "Run again" button still works for anyone with the access code.

## Project structure

```
app/page.tsx               UI (brief, CRM fixes, unsure, evals, audit, data)
app/api/extract/route.ts   AI filter + extraction + guardrails (server only)
app/api/summary/route.ts   two-sentence brief summary (Haiku)
app/api/status/route.ts    reports whether the AI key is configured
lib/prompt.ts              system prompt and JSON tool schemas
lib/guardrails.ts          quote check, injection tripwire, schema validation
lib/rules.ts               matching, ranking, CRM fixes, conflicts (no AI)
lib/evals.ts               scoring against the answer key
scripts/prepare-data.mjs   strips editorial notes, builds lib/generated/dataset.json
tests/pipeline.test.ts     tests for guardrails and rules
```

## Known limitations (honest list)

* Relative dates ("next Thursday") are resolved by the model and then validated; a production version would resolve them in code.
* "Done" status comes from what the documents show; in production it would also be detected from sent mail.
* The precision eval is an approximation: the answer key is not exhaustive, so "unsupported" items are listed for manual review rather than counted as wrong.
* State is per browser (localStorage); there is no multi-user sync in the prototype.
