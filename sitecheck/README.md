# SiteCheck

Automated website compliance/UX audit for UAE government-adjacent entities.
SiteCheck drives a real browser (Playwright) through **11 pillars / ~95 criteria**
against a target URL, captures per-question screenshot + screen-recording
evidence, and generates a bilingual (EN/AR) PDF report.

## Quick start

```bash
npm install
npx prisma generate

# create .env (see below), then:
npm run dev            # http://localhost:3000
```

Minimal `.env` (gitignored):

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_SECRET="<openssl rand -base64 32>"
NEXTAUTH_URL="http://localhost:3000"
```

**Requirements:** Node.js 20+, and Google Chrome or Microsoft Edge installed
(the engine launches the system browser headless; on Windows Smart App Control
blocks the bundled Chromium). Full env vars, optional LLM/IMAP feature gates,
and a fresh-DB setup are in **[SETUP.md](./SETUP.md)**.

## Using it

1. Sign up at `/signup`, log in.
2. **New Evaluation** (`/audit/new`) → enter target URL + entity name → *Create Audit*.
3. On the results page, **Run All Pillars** or run individual pillars; the page
   polls every 5 s. Evidence lands in `public/screenshots/<auditId>/`.
4. **Download PDF** for the bilingual report.

## Commands

```bash
npm run dev            # dev server (webpack)
npm run build          # production build
npm run start          # run production build
npm run lint           # eslint
npx prisma studio      # inspect the SQLite DB (prisma/dev.db)
```

## Docs

- **[SETUP.md](./SETUP.md)** — full setup, env vars, troubleshooting.
- **[CLAUDE.md](./CLAUDE.md)** — architecture & internals (for AI-assisted development).

> Generated audit artifacts (`public/screenshots/`, `public/reports/`) are
> gitignored — they're regenerated on each run and are not part of the source.
