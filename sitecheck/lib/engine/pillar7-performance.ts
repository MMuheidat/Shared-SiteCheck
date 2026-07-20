// lib/engine/pillar7-performance.ts — Performance & Stability (recorded journey)
// Q26 (Operates smoothly, 2/0), Q27 (No broken links/errors, 1/0),
// Q29 (No noticeable lag — non-scored), Q67 (3s load: homepage / other / search, 1pt each)
//
// Two layers:
//   • On camera (the recorder page): a short human-navigation journey, then the
//     Q67 timed clicks with an on-screen stopwatch, then either a "No bugs…"
//     title card (clean) or the single reproduced failure moment (issues found).
//   • Off camera (a hidden, non-recording context): a bounded BFS crawl of the
//     whole site that finds the real issues and load timings driving the verdicts.
//
// The crawl is fired at the start and awaited before the Q67 timed clicks, so it
// overlaps the human-navigation phase (no static video tail) yet never contends
// with the timed measurements.

import type { Browser, BrowserContext, Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, dismissCookieBanner, humanNavigate } from '@/lib/engine/helpers';
import {
  type EvidenceRecorder,
  clickWithHighlight,
  humanScrollVerify,
  installStopwatch,
  startStopwatch,
  stopStopwatch,
  hideStopwatch,
  showTitleCard,
  hideTitleCard,
} from '@/lib/engine/recording';

const PILLAR = 'Performance';
const THRESHOLD = 3000; // Q67 3-second load threshold

// Terminal progress log — the evaluator watches the dev-server output to follow
// where the engine currently is during a multi-minute recorded run (mirrors P4).
function dbg(msg: string): void {
  console.log(`[SiteCheck][P7] ${msg}`);
}

function makeResult(qid: string, overrides: Partial<CriterionResult> = {}): CriterionResult {
  const def = getCriterion(qid)!;
  return {
    qid,
    criterionNameEN: def.nameEN,
    criterionNameAR: def.nameAR,
    pillar: PILLAR,
    subPillar: def.subPillar,
    scoreEarned: 0,
    maxScore: def.maxScore,
    status: 'fail',
    screenshotPath: null,
    notes: '',
    recommendation: getRecommendation(qid),
    ...overrides,
  };
}

function ssPath(auditJobId: string, qid: string) {
  const fileName = `q${qid}.png`;
  return {
    rel: `/screenshots/${auditJobId}/${fileName}`,
    abs: path.join(process.cwd(), 'public', 'screenshots', auditJobId, fileName),
  };
}

async function viewportShot(page: Page, absPath: string): Promise<void> {
  try {
    const viewport = page.viewportSize();
    if (viewport) {
      await page.screenshot({
        path: absPath,
        clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 800) },
      });
    } else {
      await page.screenshot({ path: absPath });
    }
  } catch { /* screenshot best-effort */ }
}

const fmt = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`);

// Lightweight navigation for on-camera resets: TAMM (and many SPA gov sites)
// never reach `networkidle`, so navigateAndWait would stall the full 30s timeout
// and bloat the video. domcontentloaded + a short settle is enough for a reset.
async function gotoLight(page: Page, target: string, waitAfter = 1200): Promise<void> {
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch {
    try { await page.goto(target, { waitUntil: 'commit', timeout: 15000 }); } catch { /* */ }
  }
  await page.waitForTimeout(waitAfter);
}

function discoverInternalLinksFrom(anchors: string[], origin: string, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const href of anchors) {
    if (
      href.startsWith(origin) &&
      href !== origin &&
      href !== origin + '/' &&
      !href.includes('#') &&
      !/\.(pdf|png|jpg|jpeg|gif|svg|webp|css|js|zip|doc|docx|xls|xlsx)(\?|$)/i.test(href) &&
      !/login|log-in|signin|sign-in|signup|register|auth|uaepass|account/i.test(href) &&
      !seen.has(href)
    ) {
      seen.add(href);
      out.push(href);
    }
  }
  return out.slice(0, max);
}

async function discoverInternalLinks(page: Page, url: string, max = 5): Promise<string[]> {
  const origin = new URL(url).origin;
  const anchors: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).href),
  ).catch(() => []);
  return discoverInternalLinksFrom(anchors, origin, max);
}

// Collect all http(s) anchors on the current page (for link status checking).
async function collectAllLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    const links: string[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = (a as HTMLAnchorElement).href;
      if (href && (href.startsWith('http://') || href.startsWith('https://')) && !seen.has(href)) {
        seen.add(href);
        links.push(href);
      }
    }
    return links;
  }).catch(() => []);
}

// ────────────────────────────────────────────────────────────
//  Unified performance data (produced by the crawl, or a light fallback)
// ────────────────────────────────────────────────────────────
type IssueKind = 'http' | 'unreachable' | 'redirect-loop' | 'blank' | 'error-page' | 'broken-image';
interface CrawlIssue { url: string; kind: IssueKind; detail: string; }

interface PerfData {
  issues: CrawlIssue[];
  homepageMs: number | null;
  otherTimings: { url: string; loadMs: number }[]; // internal pages, excluding homepage
  searchMs: number | null;
  searchNote: string;
  linksChecked: number;
  brokenLinks: string[];
  jsErrorTotal: number;
  pageErrorTotal: number;
  pagesVisited: number;
  capped: boolean;
  source: 'crawl' | 'light';
}

// Read the full load time (load event, includes images/CSS) from the Navigation
// Timing API — what a user perceives as "the page has loaded".
async function readLoadMs(page: Page): Promise<number | null> {
  const v = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.loadEventEnd > 0) return Math.round(nav.loadEventEnd);
    const t = performance.timing;
    if (t && t.loadEventEnd > 0 && t.navigationStart > 0) return t.loadEventEnd - t.navigationStart;
    return -1;
  }).catch(() => -1);
  return v > 0 ? v : null;
}

async function detectContentIssues(page: Page): Promise<{ blank: boolean; errorText: boolean; brokenImages: number; imgSample: string | null }> {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').trim();
    const lower = text.toLowerCase();
    const errorText =
      lower.includes('internal server error') || lower.includes('service unavailable') ||
      lower.includes('something went wrong') || lower.includes('an error occurred') ||
      lower.includes('page not found') || (lower.includes('404') && lower.length < 600) ||
      lower.includes('حدث خطأ') || lower.includes('الصفحة غير موجودة');
    // A "broken image" = one that finished loading, has no natural size, AND
    // occupies visible layout space. The layout-space test avoids false
    // positives from hidden templates, lazy placeholders, and tracking pixels.
    const imgs = Array.from(document.images).filter((i) => {
      if (!i.currentSrc || !i.complete || i.naturalWidth !== 0) return false;
      const r = i.getBoundingClientRect();
      return r.width >= 24 && r.height >= 24;
    });
    return {
      blank: text.length < 100,
      errorText,
      brokenImages: imgs.length,
      imgSample: imgs.length ? (imgs[0].currentSrc || imgs[0].src) : null,
    };
  }).catch(() => ({ blank: false, errorText: false, brokenImages: 0, imgSample: null as string | null }));
}

// Measure the search-results load: find the search input, submit a query, and
// time until the results settle (navigation or SPA render). When a recorder is
// present the query is typed on camera with the stopwatch running.
async function measureSearch(
  page: Page,
  url: string,
  opts?: { recorder?: EvidenceRecorder; returnHome?: boolean },
): Promise<{ ms: number | null; note: string }> {
  const recorder = opts?.recorder;
  const returnHome = opts?.returnHome ?? true;
  try {
    const isArabic = await page.evaluate(
      () => /[؀-ۿ]/.test(document.body.innerText.substring(0, 2000)),
    ).catch(() => false);
    const query = isArabic ? 'خدمات' : 'services';

    const INPUT_SELECTORS = [
      'input[type="search"]', 'input[role="searchbox"]',
      'input[name*="search" i]', 'input[name="q" i]', 'input[name*="query" i]',
      'input[placeholder*="search" i]', 'input[placeholder*="بحث"]',
      'input[aria-label*="search" i]', 'input[aria-label*="بحث"]',
      'input[class*="search" i]',
    ];
    const OPENER_SELECTORS = [
      'button[aria-label*="search" i]', 'button[title*="search" i]',
      'a[aria-label*="search" i]', '[aria-label*="search" i]',
      '[class*="search-icon"]', '[class*="search-btn"]', '[class*="search-button"]',
    ];

    const findVisibleInput = async (): Promise<string | null> => {
      for (const sel of INPUT_SELECTORS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return sel;
      }
      return null;
    };

    let inputSel = await findVisibleInput();
    if (!inputSel) {
      for (const sel of OPENER_SELECTORS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          try {
            if (recorder) await clickWithHighlight(loc, { holdMs: 800 });
            else await loc.click({ timeout: 2000 });
            await page.waitForTimeout(1200);
            inputSel = await findVisibleInput();
            if (inputSel) break;
          } catch { /* try next */ }
        }
      }
    }
    if (!inputSel) return { ms: null, note: 'No search input reachable — search component not measured.' };

    const input = page.locator(inputSel).first();
    await input.click({ timeout: 3000 }).catch(() => {});
    if (recorder) await input.pressSequentially(query, { delay: 80 }).catch(() => input.fill(query).catch(() => {}));
    else await input.fill(query, { timeout: 3000 });

    if (recorder) await startStopwatch(page, { label: 'Search', thresholdMs: THRESHOLD });
    const t0 = Date.now();
    await input.press('Enter').catch(() => {});
    try { await page.waitForLoadState('networkidle', { timeout: recorder ? 8000 : 12000 }); } catch { /* SPA */ }
    const elapsed = Date.now() - t0;

    const navMs = await readLoadMs(page);
    const ms = navMs !== null && navMs < elapsed ? navMs : elapsed;

    if (recorder) {
      await stopStopwatch(page, ms);
      await page.waitForTimeout(1600);
    }
    return { ms, note: `Search for "${query}" — results settled in ${(ms / 1000).toFixed(2)}s.` };
  } catch (err) {
    return { ms: null, note: `Search measurement failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (returnHome) {
      if (recorder) await hideStopwatch(page);
      if (recorder) await gotoLight(page, url, 1200);
      else { try { await navigateAndWait(page, url, { waitAfter: 1500 }); } catch { /* */ } }
    }
  }
}

// ────────────────────────────────────────────────────────────
//  Phase 0 — stable-connection pre-check
// ────────────────────────────────────────────────────────────
async function connectionPrecheck(page: Page, url: string): Promise<{ ok: boolean; note: string }> {
  const origin = new URL(url).origin;
  // The engine already navigated the browser to the homepage before this pillar,
  // so a rendered homepage is itself proof the connection is up.
  let onSite = false;
  try { onSite = page.url().startsWith(origin) || (await readLoadMs(page)) !== null; } catch { /* */ }

  // A direct probe gives a latency figure, but WAFs frequently block raw
  // (non-browser) requests — a blocked probe is NOT a connection problem.
  const times: number[] = [];
  for (let i = 0; i < 2; i++) {
    try {
      const t0 = Date.now();
      const r = await page.context().request.get(origin, { timeout: 8000 });
      await r.body().catch(() => {});
      times.push(Date.now() - t0);
    } catch { /* likely WAF-blocked */ }
  }
  if (times.length) {
    times.sort((a, b) => a - b);
    return { ok: true, note: `Connection pre-check OK — origin responded in ~${(times[0] / 1000).toFixed(2)}s.` };
  }
  if (onSite) {
    return { ok: true, note: 'Connection pre-check: homepage loaded in the browser (direct probe blocked, likely WAF) — connection considered stable.' };
  }
  return { ok: false, note: 'Connection pre-check: could not confirm reachability — results may be unreliable (unstable connection or blocking).' };
}

// ────────────────────────────────────────────────────────────
//  Phase 1 — hidden BFS crawl (separate non-recording context)
// ────────────────────────────────────────────────────────────
// Kept tight so the crawl overlaps the ~25s on-camera human-navigation phase and
// leaves little/no static tail before the Q67 timed clicks (link checks run in
// parallel, so the crawl is dominated by the sequential BFS page loads).
const CRAWL_MAX_PAGES = 18;
const CRAWL_MAX_DEPTH = 2;
const CRAWL_TIME_BUDGET_MS = 22_000;
const CRAWL_MAX_LINK_CHECKS = 40;
const CRAWL_LINK_CONCURRENCY = 8;

async function runBackgroundCrawl(browser: Browser, url: string): Promise<PerfData> {
  const origin = new URL(url).origin;
  let context: BrowserContext | null = null;
  let jsErrorTotal = 0;
  let pageErrorTotal = 0;

  const data: PerfData = {
    issues: [], homepageMs: null, otherTimings: [], searchMs: null, searchNote: '',
    linksChecked: 0, brokenLinks: [], jsErrorTotal: 0, pageErrorTotal: 0,
    pagesVisited: 0, capped: false, source: 'crawl',
  };

  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') jsErrorTotal++; });
    page.on('pageerror', () => { pageErrorTotal++; });

    const deadline = Date.now() + CRAWL_TIME_BUDGET_MS;
    const seen = new Set<string>();
    const linkPool = new Set<string>(); // all http(s) links found, for status checks
    const queue: { u: string; depth: number }[] = [{ u: url, depth: 0 }];
    seen.add(url.replace(/\/+$/, ''));

    while (queue.length && data.pagesVisited < CRAWL_MAX_PAGES && Date.now() < deadline) {
      const { u, depth } = queue.shift()!;
      let status = 0;
      let navError: string | null = null;
      let response: import('playwright').Response | null = null;
      try {
        response = await page.goto(u, { waitUntil: 'load', timeout: 30000 });
        status = response?.status() ?? 0;
      } catch (err) {
        navError = err instanceof Error ? err.message : String(err);
      }
      data.pagesVisited++;

      if (navError) {
        const isRedirectLoop = /redirect|ERR_TOO_MANY_REDIRECTS/i.test(navError);
        data.issues.push({
          url: u,
          kind: isRedirectLoop ? 'redirect-loop' : 'unreachable',
          detail: isRedirectLoop ? 'redirect loop / too many redirects' : navError.substring(0, 120),
        });
        dbg(`crawl: ${u} → ${isRedirectLoop ? 'REDIRECT LOOP' : 'UNREACHABLE'}`);
        continue;
      }

      // Redirect-chain length (a loop that the browser gave up following would
      // have thrown above; this catches long-but-successful chains too).
      let hops = 0;
      let req = response?.request().redirectedFrom() ?? null;
      while (req) { hops++; req = req.redirectedFrom(); }

      const loadMs = await readLoadMs(page);
      await page.waitForTimeout(400);
      const content = await detectContentIssues(page);

      if (status >= 400) {
        data.issues.push({ url: u, kind: 'http', detail: `HTTP ${status}` });
        dbg(`crawl: ${u} → HTTP ${status}`);
      } else if (content.blank) {
        data.issues.push({ url: u, kind: 'blank', detail: 'page rendered blank' });
        dbg(`crawl: ${u} → BLANK`);
      } else if (content.errorText) {
        data.issues.push({ url: u, kind: 'error-page', detail: 'error message shown on page' });
        dbg(`crawl: ${u} → ERROR PAGE`);
      }
      if (hops >= 10) {
        data.issues.push({ url: u, kind: 'redirect-loop', detail: `${hops} redirect hops` });
      }
      if (content.brokenImages > 0) {
        data.issues.push({
          url: u, kind: 'broken-image',
          detail: `${content.brokenImages} broken image(s)${content.imgSample ? ` (e.g. ${content.imgSample.substring(0, 80)})` : ''}`,
        });
        dbg(`crawl: ${u} → ${content.brokenImages} broken image(s)`);
      }

      if (loadMs !== null) {
        if (u === url || u.replace(/\/+$/, '') === url.replace(/\/+$/, '')) data.homepageMs = loadMs;
        else data.otherTimings.push({ url: u, loadMs });
      }

      // Gather links for BFS + status pool
      const pageLinks = await collectAllLinks(page);
      for (const l of pageLinks) linkPool.add(l);
      if (depth < CRAWL_MAX_DEPTH) {
        for (const next of discoverInternalLinksFrom(pageLinks, origin, 999)) {
          const key = next.replace(/\/+$/, '');
          if (!seen.has(key) && seen.size < CRAWL_MAX_PAGES * 2) {
            seen.add(key);
            queue.push({ u: next, depth: depth + 1 });
          }
        }
      }
    }
    data.capped = queue.length > 0 || data.pagesVisited >= CRAWL_MAX_PAGES;
    dbg(`crawl: visited ${data.pagesVisited} page(s)${data.capped ? ' (capped)' : ''}, ${data.issues.length} page issue(s) so far`);

    // ── Link status pass (the "every internal link" HTTP check) ──
    // Only a real HTTP error *response* (404/410/5xx) counts as broken — a thrown
    // request (timeout, TLS, connection reset) is treated as UNVERIFIABLE, never
    // broken, because WAFs/CDNs on gov sites routinely block raw non-browser
    // requests for links that work perfectly in a real browser.
    const linksToCheck = Array.from(linkPool).slice(0, CRAWL_MAX_LINK_CHECKS);
    let unverifiable = 0;
    for (let i = 0; i < linksToCheck.length; i += CRAWL_LINK_CONCURRENCY) {
      if (Date.now() > deadline + 12_000) break; // hard stop for the link pass
      const batch = linksToCheck.slice(i, i + CRAWL_LINK_CONCURRENCY);
      await Promise.all(batch.map(async (link) => {
        try {
          const r = await context!.request.get(link, { timeout: 9000 });
          data.linksChecked++;
          const s = r.status();
          if (s === 404 || s === 410 || (s >= 500 && s < 600)) {
            data.brokenLinks.push(`${link} (${s})`);
            data.issues.push({ url: link, kind: 'http', detail: `broken link HTTP ${s}` });
          }
          // 401/403/405/429/999 → bot-blocked / auth-gated: works for real users
        } catch {
          data.linksChecked++;
          unverifiable++; // blocked/timeout — unverifiable, not counted as broken
        }
      }));
    }
    dbg(`crawl: checked ${data.linksChecked} link(s), ${data.brokenLinks.length} broken, ${unverifiable} unverifiable (blocked/timeout, not counted)`);

    // ── Search timing (hidden) ──
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch { /* */ }
    const search = await measureSearch(page, url, { returnHome: false });
    data.searchMs = search.ms;
    data.searchNote = search.note;
  } catch (err) {
    dbg(`crawl aborted: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    data.jsErrorTotal = jsErrorTotal;
    data.pageErrorTotal = pageErrorTotal;
    if (context) await context.close().catch(() => {});
  }
  return data;
}

// Light fallback when no browser handle is available for a separate context.
async function lightMeasure(page: Page, url: string): Promise<PerfData> {
  const data: PerfData = {
    issues: [], homepageMs: null, otherTimings: [], searchMs: null, searchNote: '',
    linksChecked: 0, brokenLinks: [], jsErrorTotal: 0, pageErrorTotal: 0,
    pagesVisited: 0, capped: true, source: 'light',
  };
  const targets = [url, ...(await discoverInternalLinks(page, url, 3))];
  for (const t of targets) {
    let jsErr = 0;
    const onConsole = (m: import('playwright').ConsoleMessage) => { if (m.type() === 'error') jsErr++; };
    page.on('console', onConsole);
    try {
      const resp = await page.goto(t, { waitUntil: 'load', timeout: 45000 });
      const status = resp?.status() ?? 0;
      const loadMs = await readLoadMs(page);
      await page.waitForTimeout(1000);
      const content = await detectContentIssues(page);
      data.pagesVisited++;
      if (status >= 400) data.issues.push({ url: t, kind: 'http', detail: `HTTP ${status}` });
      else if (content.blank) data.issues.push({ url: t, kind: 'blank', detail: 'page rendered blank' });
      else if (content.errorText) data.issues.push({ url: t, kind: 'error-page', detail: 'error message shown on page' });
      if (content.brokenImages > 0) data.issues.push({ url: t, kind: 'broken-image', detail: `${content.brokenImages} broken image(s)` });
      if (loadMs !== null) { if (t === url) data.homepageMs = loadMs; else data.otherTimings.push({ url: t, loadMs }); }
    } catch {
      data.issues.push({ url: t, kind: 'unreachable', detail: 'failed to load' });
    } finally {
      data.jsErrorTotal += jsErr;
      page.removeListener('console', onConsole);
    }
  }
  const links = (await collectAllLinks(page)).slice(0, 20);
  for (const link of links) {
    try {
      const r = await page.context().request.get(link, { timeout: 10000 });
      data.linksChecked++;
      const s = r.status();
      if (s === 404 || s === 410 || (s >= 500 && s < 600)) {
        data.brokenLinks.push(`${link} (${s})`);
        data.issues.push({ url: link, kind: 'http', detail: `broken link HTTP ${s}` });
      }
    } catch {
      data.linksChecked++;
      // thrown request → unverifiable (likely WAF/CDN block), not counted as broken
    }
  }
  const search = await measureSearch(page, url, { returnHome: true });
  data.searchMs = search.ms;
  data.searchNote = search.note;
  return data;
}

// ────────────────────────────────────────────────────────────
//  Phase 2 — on-camera human navigation
// ────────────────────────────────────────────────────────────
async function clickOneContentItem(page: Page, recorder: EvidenceRecorder): Promise<void> {
  try {
    const origin = new URL(page.url()).origin;
    // Prefer a prominent in-content internal link that is visible in the viewport.
    const handle = await page.evaluateHandle((orig: string) => {
      const inViewport = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.top >= 60 && r.left >= 0 && r.bottom <= window.innerHeight && r.width > 40 && r.height > 10;
      };
      const anchors = Array.from(document.querySelectorAll('main a[href], article a[href], [role="main"] a[href], a[href]'));
      for (const a of anchors) {
        const el = a as HTMLAnchorElement;
        const txt = (el.textContent || '').trim();
        if (el.href.startsWith(orig) && txt.length > 3 && txt.length < 60 && inViewport(el)) return el;
      }
      return null;
    }, origin);
    const el = handle.asElement();
    if (el) {
      await el.evaluate((n: Element) => { (n as HTMLAnchorElement).target = '_self'; }).catch(() => {});
      const loc = page.locator(`a[href="${await el.evaluate((n: Element) => (n as HTMLAnchorElement).getAttribute('href') || '')}"]`).first();
      if (await loc.isVisible().catch(() => false)) {
        await recorder.setCaption('Q26 — Opening an item and reading it, like a visitor…');
        await clickWithHighlight(loc, { holdMs: 1000, timeout: 5000 });
        try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* */ }
      }
    }
    await handle.dispose().catch(() => {});
  } catch { /* best-effort; dwell happens regardless */ }
}

async function humanNavigationJourney(page: Page, url: string, recorder: EvidenceRecorder): Promise<void> {
  await recorder.setCaption('Q26 — Browsing the site like a visitor to check it operates smoothly…');
  const all = await discoverInternalLinks(page, url, 25);
  const preferred = all.filter(l => /service|support|contact|about|help|faq|news|media/i.test(l));
  const chosen = Array.from(new Set([...preferred, ...all])).slice(0, 2);
  dbg(`human journey: visiting ${chosen.length} internal page(s)`);

  for (let i = 0; i < chosen.length; i++) {
    const link = chosen[i];
    try {
      // Reset to the homepage between visits so navigation looks deliberate.
      if (page.url().replace(/\/+$/, '') !== url.replace(/\/+$/, '')) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(700);
        if (page.url().replace(/\/+$/, '') !== url.replace(/\/+$/, '')) {
          await gotoLight(page, url, 1000);
        }
      }
      await recorder.setCaption(`Q26 — Visiting an internal page (${i + 1} of ${chosen.length})…`);
      dbg(`human journey: page ${i + 1}/${chosen.length}: ${link}`);
      await humanNavigate(page, link, recorder);
      await humanScrollVerify(page, { maxSteps: 3, delayMs: 350 });
      await clickOneContentItem(page, recorder);
      await recorder.setCaption('Q26 — Reading the page content…');
      await page.waitForTimeout(6000); // 5–8s human dwell
    } catch (err) {
      dbg(`human journey: page ${i + 1} error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Return home for the Q67 timed clicks.
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(700);
    if (page.url().replace(/\/+$/, '') !== url.replace(/\/+$/, '')) {
      await gotoLight(page, url, 1200);
    }
  } catch { /* */ }
}

// ────────────────────────────────────────────────────────────
//  Phase 3 — Q67 on-camera timed clicks with the stopwatch overlay
// ────────────────────────────────────────────────────────────
async function timedNavClick(
  page: Page, url: string, target: string, label: string, recorder: EvidenceRecorder,
): Promise<number | null> {
  try {
    // Ensure we start on the homepage.
    if (page.url().replace(/\/+$/, '') !== url.replace(/\/+$/, '')) {
      await gotoLight(page, url, 1200);
    }
    await recorder.setCaption(`Q67 — Timing the load of ${label} (target < 3s)…`);
    const sel = (() => { try { const u = new URL(target); return `a[href="${target}"], a[href="${u.pathname + u.search}"]`; } catch { return `a[href="${target}"]`; } })();
    const anchor = page.locator(sel).first();
    const clickable = await anchor.isVisible().catch(() => false);

    await startStopwatch(page, { label, thresholdMs: THRESHOLD });
    const t0 = Date.now();
    if (clickable) {
      await anchor.evaluate((el: Element) => { (el as HTMLAnchorElement).target = '_self'; }).catch(() => {});
      await clickWithHighlight(anchor, { holdMs: 1000, timeout: 5000 });
    } else {
      await page.goto(target, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    }
    try { await page.waitForLoadState('load', { timeout: 30000 }); } catch { /* */ }
    try { await page.waitForLoadState('networkidle', { timeout: 3500 }); } catch { /* */ }
    const elapsed = Date.now() - t0;
    const navMs = await readLoadMs(page);
    const ms = navMs !== null && navMs > 0 && navMs < elapsed + 500 ? navMs : elapsed;

    await stopStopwatch(page, ms);
    dbg(`Q67 timed: ${label} = ${(ms / 1000).toFixed(2)}s`);
    await page.waitForTimeout(1600); // hold the frozen timer on camera
    return ms;
  } catch (err) {
    dbg(`Q67 timed ${label} error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar7Performance(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
  recorder?: EvidenceRecorder;
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, recorder } = params;
  const results: CriterionResult[] = [];
  const browser = page.context().browser();

  await dismissCookieBanner(page);
  if (recorder) await installStopwatch(page);

  // ── Phase 0 — connection pre-check ──
  const conn = await connectionPrecheck(page, url);
  dbg(conn.note);

  // ── Phase 1 — fire the hidden crawl (do not await yet) ──
  const crawlPromise: Promise<PerfData | null> = browser
    ? runBackgroundCrawl(browser, url).catch((err) => {
        dbg(`crawl promise rejected: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
    : Promise.resolve(null);

  // ── Phase 2 — on-camera human navigation (overlaps the crawl) ──
  if (recorder) {
    await humanNavigationJourney(page, url, recorder);
  }

  // ── Phase 3 — await crawl, then Q67 timed clicks (no contention) ──
  // The crawl runs in a hidden context; narrate the brief wait so any residual
  // tail before it finishes isn't stale "reading content" dead air.
  if (recorder) await recorder.setCaption('Verifying links and pages across the site…');
  let data = await crawlPromise;
  if (!data) {
    dbg('crawl unavailable — falling back to light in-page measurement');
    data = await lightMeasure(page, url);
  }

  // Ensure we are back on the homepage for the timed clicks.
  if (recorder) await gotoLight(page, url, 1500);
  else { try { await navigateAndWait(page, url, { waitAfter: 1500 }); } catch { /* */ } }
  await dismissCookieBanner(page);

  // Sampled on-camera timings (also count toward Q67).
  const samples: { home: number | null; internal: number | null; search: number | null } = {
    home: null, internal: null, search: null,
  };
  if (recorder) {
    // Homepage: time a reload of the homepage.
    samples.home = await timedNavClick(page, url, url, 'Homepage', recorder);
    // One internal page.
    const internalTarget = (data.otherTimings[0]?.url) || (await discoverInternalLinks(page, url, 1))[0];
    if (internalTarget) samples.internal = await timedNavClick(page, url, internalTarget, 'Internal page', recorder);
    await hideStopwatch(page);
    // Search results.
    await gotoLight(page, url, 1200);
    const s = await measureSearch(page, url, { recorder, returnHome: true });
    samples.search = s.ms;
  }

  // ── Consolidate timings ──
  const homeTimings = [data.homepageMs, samples.home].filter((v): v is number => v !== null);
  const otherTimingsAll = [
    ...data.otherTimings.map(t => t.loadMs),
    ...(samples.internal !== null ? [samples.internal] : []),
  ];
  const searchTimings = [data.searchMs, samples.search].filter((v): v is number => v !== null);
  const allTimings = [...homeTimings, ...otherTimingsAll, ...searchTimings];
  const avg = allTimings.length ? allTimings.reduce((a, b) => a + b, 0) / allTimings.length : null;
  const maxT = allTimings.length ? Math.max(...allTimings) : null;

  const coverage = data.source === 'crawl'
    ? `Crawled ${data.pagesVisited} page(s)${data.capped ? ' (site larger than the crawl budget — capped)' : ''} and status-checked ${data.linksChecked} link(s).`
    : `Light check: measured ${data.pagesVisited} page(s) and ${data.linksChecked} link(s) (full-site crawl unavailable).`;

  // Hard issues (Decision: console/JS/page errors do NOT fail; they are informational).
  const hardIssues = data.issues;
  const issuesClean = hardIssues.length === 0;

  // ── Q26 — Operates smoothly (binary 2/0) ──
  {
    const ss = ssPath(auditJobId, '26');
    if (issuesClean) {
      await viewportShot(page, ss.abs);
      if (recorder) {
        await showTitleCard(page, 'No bugs, glitches, or broken links detected');
        await page.waitForTimeout(2500);
        await hideTitleCard(page);
      }
    }
    results.push(makeResult('Q26', {
      scoreEarned: issuesClean ? 2 : 0,
      status: issuesClean ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: issuesClean
        ? `Browsed the site without crashes, HTTP errors, blank pages, error pages, broken images, or redirect loops. ${coverage} Console JS errors: ${data.jsErrorTotal}, uncaught page errors: ${data.pageErrorTotal} (non-blocking, not counted).`
        : `Stability problems detected on ${hardIssues.length} location(s): ${hardIssues.slice(0, 6).map(i => `${i.url} — ${i.kind}: ${i.detail}`).join('; ')}. ${coverage}`,
      recommendation: issuesClean ? '' : getRecommendation('Q26'),
    }));
  }

  // ── Q27 — No bugs / glitches / broken links / errors (binary 1/0) ──
  {
    const ss = ssPath(auditJobId, '27');
    // If issues exist, reproduce the single worst one on camera and screenshot it.
    if (!issuesClean) {
      const priority: IssueKind[] = ['http', 'unreachable', 'redirect-loop', 'error-page', 'blank', 'broken-image'];
      const worst = [...hardIssues].sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind))[0];
      dbg(`reproducing worst issue on camera: ${worst.kind} @ ${worst.url}`);
      if (recorder) await recorder.setCaption(`Issue found — ${worst.kind}: ${worst.detail}`);
      try {
        await page.goto(worst.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch { /* the failure itself may prevent load — that is the evidence */ }
      await page.waitForTimeout(2500);
      await viewportShot(page, ssPath(auditJobId, '26').abs); // overwrite Q26 shot with the failure moment
      await viewportShot(page, ss.abs);
    } else {
      await viewportShot(page, ss.abs);
    }
    const brokenNote = data.brokenLinks.length ? ` Broken links: ${data.brokenLinks.slice(0, 5).join('; ')}.` : '';
    results.push(makeResult('Q27', {
      scoreEarned: issuesClean ? 1 : 0,
      status: issuesClean ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: issuesClean
        ? `No bugs, glitches, broken links, or error pages encountered. ${coverage}${brokenNote}`
        : `Issues encountered (${hardIssues.length}): ${hardIssues.slice(0, 6).map(i => `${i.kind} @ ${new URL(i.url).pathname || '/'}`).join(', ')}. ${coverage}${brokenNote}`,
      recommendation: issuesClean ? '' : getRecommendation('Q27'),
    }));
  }

  // ── Q29 — No noticeable lag during navigation (non-scored) ──
  {
    const ss = ssPath(auditJobId, '29');
    await viewportShot(page, ss.abs);
    if (avg === null) {
      results.push(makeResult('Q29', {
        status: 'na',
        screenshotPath: ss.rel,
        notes: 'Could not collect page timings to assess navigation lag.',
      }));
    } else {
      const passed = avg <= 4000 && (maxT as number) <= 8000;
      results.push(makeResult('Q29', {
        status: passed ? 'pass' : 'fail',
        screenshotPath: ss.rel,
        notes: `Average load ${fmt(avg)}, slowest ${fmt(maxT)} across ${allTimings.length} measured navigation(s). ` +
          (passed ? 'No noticeable lag observed during navigation.' : 'Noticeable delay observed during navigation.'),
      }));
    }
  }

  // ── Q67 — 3-second load: Homepage [1] + Other Pages [1] + Search Results [1] ──
  {
    // Homepage: the on-camera timed click is the representative measurement (what
    // the stopwatch shows on video), so the score matches the footage. The cold
    // crawl load is reported for transparency but doesn't override the sample.
    const homeShown = samples.home ?? data.homepageMs;
    const homepageOk = homeShown !== null && homeShown <= THRESHOLD;
    // Other/Search: apply the "any page anywhere > 3s → category fails" rule
    // across every measured internal/search page.
    const otherMax = otherTimingsAll.length ? Math.max(...otherTimingsAll) : null;
    const searchMax = searchTimings.length ? Math.max(...searchTimings) : null;
    const otherOk = otherMax !== null && otherMax <= THRESHOLD;
    const searchOk = searchMax !== null && searchMax <= THRESHOLD;

    let score = 0;
    if (homepageOk) score++;
    if (otherOk) score++;
    if (searchOk) score++;

    const ss = ssPath(auditJobId, '67');
    await viewportShot(page, ss.abs);

    const coldNote = (samples.home !== null && data.homepageMs !== null && data.homepageMs > THRESHOLD)
      ? ` (cold first-load measured ${fmt(data.homepageMs)})` : '';
    const parts = [
      `Homepage: ${fmt(homeShown)} ${homepageOk ? '✓ [1]' : '✗ [0]'}${coldNote}`,
      `Other pages (${otherTimingsAll.length} measured, slowest ${fmt(otherMax)}): ${otherOk ? '✓ [1]' : otherMax === null ? '— not measurable [0]' : '✗ [0]'}`,
      `Search results (slowest ${fmt(searchMax)}): ${searchOk ? '✓ [1]' : searchMax === null ? '— not measurable [0]' : '✗ [0]'}`,
    ];

    results.push(makeResult('Q67', {
      scoreEarned: score,
      status: score === 3 ? 'pass' : score > 0 ? 'partial' : 'fail',
      screenshotPath: ss.rel,
      notes: `3-second load check (full load event). ${parts.join(' | ')}. ${coverage}` +
        `${data.searchMs === null && samples.search === null ? ` ${data.searchNote}` : ''}`,
      recommendation: score === 3 ? '' : getRecommendation('Q67'),
    }));
  }

  dbg(`done: Q26 ${results[0].status}, Q27 ${results[1].status}, Q29 ${results[2].status}, Q67 ${results[3].scoreEarned}/3`);
  return results;
}
