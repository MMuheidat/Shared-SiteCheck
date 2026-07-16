# SiteCheck — Setup & Run Guide

SiteCheck automates a website compliance/UX audit (11 pillars, ~95 criteria) against a target URL, aimed at UAE government-adjacent entities. It drives a real browser with Playwright, stores per-criterion results with screenshot/video evidence, and generates a bilingual (EN/AR) PDF report.

## Prerequisites

- **Node.js 20+** and npm
- **Google Chrome or Microsoft Edge installed** — the audit engine launches the system browser (headless). This matters on Windows machines with Smart App Control, which blocks Playwright's bundled headless Chromium. If you have neither, run `npx playwright install chromium` as a fallback.
- **Optional — Ollama** (local LLM, default judge): needed only for the live-chat / enquiry soft-skill grading. Install from https://ollama.com, then `ollama pull llama3.1`. Alternatively use an Anthropic API key (see env vars), or leave the judge off — those questions are then marked `na`, never failed.

## 1. Install

```bash
npm install
npx prisma generate
```

## 2. Environment variables

Create a `.env` file in the project root (`.env` is gitignored). Minimal working config:

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_SECRET="<generate: openssl rand -base64 32>"
NEXTAUTH_URL="http://localhost:3000"

# LLM judge for chat/email soft-skill questions: ollama | anthropic | off
LIVECHAT_LLM_PROVIDER="ollama"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="llama3.1"
```

Optional gates and services (all default **off** — safe for dry runs):

```env
# Allow Pillar 9 to actually send messages in a live chat
# (records a video of the conversation, grades transcript via the LLM judge)
SITECHECK_LIVECHAT_SUBMIT=1

# Allow Pillar 10 to actually submit the enquiry form and start the
# async email tail (Q56–Q66 are emitted as "pending")
SITECHECK_ENQUIRY_SUBMIT=1
ENQUIRY_TEST_EMAIL="inbox-you-control@example.com"
ENQUIRY_TEST_FIRST_NAME="..."
ENQUIRY_TEST_LAST_NAME="..."

# Inbox the enquiry email tail reads (IMAP)
ENQUIRY_IMAP_HOST="imap.example.com"
ENQUIRY_IMAP_PORT=993
ENQUIRY_IMAP_USER="..."
ENQUIRY_IMAP_PASS="..."
ENQUIRY_IMAP_TLS=1

# Use Anthropic instead of Ollama for the judge
# LIVECHAT_LLM_PROVIDER="anthropic"
# ANTHROPIC_API_KEY="sk-ant-..."
# ANTHROPIC_MODEL="claude-opus-4-8"
```

## 3. Database

The SQLite database lives at `prisma/dev.db` (a working copy is committed with historical audit data). To start from a **fresh** database:

```bash
# point DATABASE_URL at a new file (or delete prisma/dev.db), then:
npx prisma db push
```

> Use `db push`, not `migrate dev` — the committed migration predates several schema fields (`CriterionResult.isAutomatic/checkType/dependsOn`, the `PendingEnquiry` model), so migrations alone will not reproduce the current schema.

Inspect the DB anytime with `npx prisma studio`.

## 4. Run

```bash
npm run dev          # development server on http://localhost:3000
```

Production:

```bash
npm run build
npm run start
```

## 5. Using the app

1. Open http://localhost:3000 and **sign up** an account (`/signup`), then log in.
2. **New Evaluation** (`/audit/new`): enter the target URL, entity name, optional service name, language, device type → *Create Audit* (nothing runs yet).
3. On the **results page**, either click **Run All Pillars** (full sequential evaluation, ~10–30 min depending on the site) or run/re-run **individual pillars** from their cards. The page polls and updates every 5 s.
4. Evidence screenshots appear per criterion in the results table; files land in `public/screenshots/<auditId>/`.
5. **Download PDF** generates the bilingual report (saved under `public/reports/`).

## Notes & troubleshooting

- **Browser fails to launch** → install Chrome or Edge (see prerequisites); the engine tries Chrome → Edge → bundled Chromium, all headless.
- **Live-chat / enquiry questions come back `na`** → the corresponding `SITECHECK_*_SUBMIT` gate is off, or the LLM judge is unreachable (is Ollama running?). This is by design — the judge failing never fails an audit.
- **Audit stuck `partial` with `pending` questions** → those are Pillar 10 email-tail questions awaiting an enquiry reply; the background poller that resolves them is not part of this tree yet.
- **Port 3000 busy** → `npm run dev -- -p 3001` (also update `NEXTAUTH_URL`).
- Project architecture documentation for AI-assisted development lives in `CLAUDE.md`.
