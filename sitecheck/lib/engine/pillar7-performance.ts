// lib/engine/pillar7-performance.ts — Performance & Stability
// Q26 (Operates smoothly, 2/0), Q27 (No broken links/errors, 1/0),
// Q29 (No noticeable lag — non-scored), Q67 (3s load: homepage / other pages / search, 1pt each)
//
// One measurement phase visits the homepage + internal pages, timing each load
// and recording stability signals. Q26/Q29/Q67 all read from those measurements
// so every page is loaded (and timed) exactly once.

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, dismissCookieBanner } from '@/lib/engine/helpers';

const PILLAR = 'Performance';

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
  const viewport = page.viewportSize();
  if (viewport) {
    await page.screenshot({
      path: absPath,
      clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 800) },
    });
  } else {
    await page.screenshot({ path: absPath });
  }
}

async function discoverInternalLinks(page: Page, url: string, max = 5): Promise<string[]> {
  const origin = new URL(url).origin;
  const links: string[] = await page.evaluate((orig: string) => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const seen = new Set<string>();
    const results: string[] = [];
    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).href;
      if (
        href.startsWith(orig) &&
        href !== orig &&
        href !== orig + '/' &&
        !href.includes('#') &&
        !/\.(pdf|png|jpg|jpeg|gif|svg|webp|css|js|zip|doc|docx|xls|xlsx)(\?|$)/i.test(href) &&
        !/login|log-in|signin|sign-in|signup|register|auth|uaepass|account/i.test(href) &&
        !seen.has(href)
      ) {
        seen.add(href);
        results.push(href);
      }
    }
    return results;
  }, origin);
  return links.slice(0, max);
}

// ────────────────────────────────────────────────────────────
//  Measurement phase — every page loaded and timed once
// ────────────────────────────────────────────────────────────
interface PageMeasurement {
  url: string;
  loadMs: number | null;      // full load (load event); null if navigation failed
  httpStatus: number;
  navFailed: boolean;
  blankPage: boolean;
  errorText: boolean;
  jsErrors: number;
}

async function measurePage(page: Page, pageUrl: string): Promise<PageMeasurement> {
  const jsErrors: string[] = [];
  const errorHandler = (msg: import('playwright').ConsoleMessage) => {
    if (msg.type() === 'error') jsErrors.push(msg.text().substring(0, 120));
  };
  page.on('console', errorHandler);

  const m: PageMeasurement = {
    url: pageUrl, loadMs: null, httpStatus: 0,
    navFailed: false, blankPage: false, errorText: false, jsErrors: 0,
  };

  try {
    const response = await page.goto(pageUrl, { waitUntil: 'load', timeout: 45000 });
    m.httpStatus = response?.status() ?? 0;

    // Full load time from the Navigation Timing API (what a user perceives as
    // "the page has loaded" — includes images/CSS, unlike DOMContentLoaded)
    m.loadMs = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav && nav.loadEventEnd > 0) return Math.round(nav.loadEventEnd);
      const t = performance.timing;
      if (t && t.loadEventEnd > 0 && t.navigationStart > 0) return t.loadEventEnd - t.navigationStart;
      return -1;
    });
    if (m.loadMs !== null && m.loadMs < 0) m.loadMs = null;

    await page.waitForTimeout(1500);

    const content = await page.evaluate(() => {
      const text = (document.body.innerText || '').trim();
      const lower = text.toLowerCase();
      return {
        length: text.length,
        errorText:
          lower.includes('internal server error') || lower.includes('service unavailable') ||
          lower.includes('something went wrong') || lower.includes('an error occurred') ||
          lower.includes('page not found') || lower.includes('404') && lower.length < 600 ||
          lower.includes('حدث خطأ') || lower.includes('الصفحة غير موجودة'),
      };
    });
    m.blankPage = content.length < 100;
    m.errorText = content.errorText;
  } catch {
    m.navFailed = true;
  } finally {
    page.removeListener('console', errorHandler);
    m.jsErrors = jsErrors.length;
  }
  return m;
}

// Measure the search-results load: find the search input, submit a query, and
// time until the results settle (navigation or SPA render).
async function measureSearch(page: Page, url: string): Promise<{ ms: number | null; note: string }> {
  try {
    const isArabic = await page.evaluate(
      () => /[؀-ۿ]/.test(document.body.innerText.substring(0, 2000))
    );
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
            await loc.click({ timeout: 2000 });
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
    await input.fill(query, { timeout: 3000 });

    const t0 = Date.now();
    await input.press('Enter').catch(() => {});
    // Results settle either via navigation or SPA rendering
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* SPA */ }
    const elapsed = Date.now() - t0;

    // Prefer real navigation timing if the search caused a page navigation
    const navMs = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : -1;
    }).catch(() => -1);

    const ms = navMs > 0 && navMs < elapsed ? navMs : elapsed;
    return { ms, note: `Search for "${query}" — results settled in ${(ms / 1000).toFixed(2)}s.` };
  } catch (err) {
    return { ms: null, note: `Search measurement failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { await navigateAndWait(page, url, { waitAfter: 2000 }); } catch { /* */ }
  }
}

const fmt = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`);

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar7Performance(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId } = params;
  const results: CriterionResult[] = [];

  await dismissCookieBanner(page);

  // ── Measurement phase: homepage + up to 3 internal pages, timed once each ──
  const internalLinks = await discoverInternalLinks(page, url, 3);
  const homepage = await measurePage(page, url);
  await dismissCookieBanner(page);
  const otherPages: PageMeasurement[] = [];
  for (const link of internalLinks) {
    otherPages.push(await measurePage(page, link));
  }

  // Back home for the search measurement and evidence shots
  try { await navigateAndWait(page, url, { waitAfter: 2000 }); } catch { /* */ }
  await dismissCookieBanner(page);
  const search = await measureSearch(page, url);

  const allPages = [homepage, ...otherPages];
  const timings = allPages.filter(p => p.loadMs !== null).map(p => p.loadMs as number);
  if (search.ms !== null) timings.push(search.ms);

  // ── Q26 — Operates smoothly (binary 2/0 per criteria sheet) ──
  // Fails on user-visible problems: crashes/nav failures, HTTP errors,
  // blank pages, or rendered error pages. Console noise alone does not fail
  // this criterion (it is reported in the notes and weighed in Q27).
  {
    const problems: string[] = [];
    for (const p of allPages) {
      if (p.navFailed) problems.push(`${p.url}: failed to load`);
      else if (p.httpStatus >= 400) problems.push(`${p.url}: HTTP ${p.httpStatus}`);
      else if (p.blankPage) problems.push(`${p.url}: page rendered blank`);
      else if (p.errorText) problems.push(`${p.url}: error message shown on page`);
    }
    const totalJsErrors = allPages.reduce((s, p) => s + p.jsErrors, 0);

    const ss = ssPath(auditJobId, '26');
    await viewportShot(page, ss.abs);

    const passed = problems.length === 0;
    results.push(makeResult('Q26', {
      scoreEarned: passed ? 2 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: passed
        ? `Browsed ${allPages.length} pages (homepage + ${otherPages.length} internal) without crashes, HTTP errors, blank pages, or visible error messages. Console JS errors observed: ${totalJsErrors} (non-blocking).`
        : `Problems on ${problems.length} of ${allPages.length} pages: ${problems.join('; ')}. Console JS errors: ${totalJsErrors}.`,
      recommendation: passed ? '' : getRecommendation('Q26'),
    }));
  }

  // ── Q27 — No broken links / errors (binary 1/0) ──
  {
    const allLinks: string[] = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const links: string[] = [];
      const seen = new Set<string>();
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        if (href && (href.startsWith('http://') || href.startsWith('https://')) && !seen.has(href)) {
          seen.add(href);
          links.push(href);
        }
      }
      return links;
    });

    const origin = new URL(url).origin;
    const linksToCheck = allLinks.slice(0, 20);
    let totalChecked = 0;
    let brokenCount = 0;
    let unverifiable = 0;
    const brokenLinks: string[] = [];

    for (const link of linksToCheck) {
      const isInternal = link.startsWith(origin);
      try {
        const response = await page.context().request.get(link, { timeout: 10000 });
        totalChecked++;
        const status = response.status();
        if (status === 404 || status === 410 || (status >= 500 && status < 600)) {
          brokenCount++;
          brokenLinks.push(`${link} (${status})`);
        } else if (status === 401 || status === 403 || status === 405 || status === 429 || status === 999) {
          // Bot-blocking / auth-gated responses — the link works for real users
          unverifiable++;
        }
      } catch {
        totalChecked++;
        if (isInternal) {
          // Internal link that cannot be fetched at all — treat as broken
          brokenCount++;
          brokenLinks.push(`${link} (unreachable)`);
        } else {
          // External hosts often block automated requests — not proof of breakage
          unverifiable++;
        }
      }
    }

    const ss = ssPath(auditJobId, '27');
    await viewportShot(page, ss.abs);

    const passed = brokenCount === 0;
    results.push(makeResult('Q27', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Checked ${totalChecked} of ${allLinks.length} links: ${brokenCount} broken, ${unverifiable} unverifiable (bot-blocked external — not counted as broken).` +
        (brokenLinks.length ? ` Broken: ${brokenLinks.slice(0, 5).join('; ')}.` : ''),
      recommendation: passed ? '' : getRecommendation('Q27'),
    }));
  }

  // ── Q29 — No noticeable lag during navigation (non-scored) ──
  {
    const avg = timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : null;
    const max = timings.length ? Math.max(...timings) : null;

    const ss = ssPath(auditJobId, '29');
    await viewportShot(page, ss.abs);

    const detail = allPages.map(p => `${new URL(p.url).pathname || '/'}: ${fmt(p.loadMs)}`).join(', ');
    if (avg === null) {
      results.push(makeResult('Q29', {
        status: 'na',
        screenshotPath: ss.rel,
        notes: 'Could not collect page timings to assess navigation lag.',
      }));
    } else {
      // "Noticeable lag": average above ~4s or any single navigation above 8s
      const passed = avg <= 4000 && (max as number) <= 8000;
      results.push(makeResult('Q29', {
        status: passed ? 'pass' : 'fail',
        screenshotPath: ss.rel,
        notes: `Average load ${fmt(avg)}, slowest ${fmt(max)}. Pages: ${detail}${search.ms !== null ? `, search: ${fmt(search.ms)}` : ''}. ` +
          (passed ? 'No noticeable lag during navigation.' : 'Noticeable delay detected during navigation.'),
      }));
    }
  }

  // ── Q67 — 3-second load: Homepage [1] + Other Pages [1] + Search Results [1] ──
  {
    const THRESHOLD = 3000;

    const homepageOk = homepage.loadMs !== null && homepage.loadMs <= THRESHOLD;
    const otherMeasured = otherPages.filter(p => p.loadMs !== null);
    const otherOk = otherMeasured.length > 0 && otherMeasured.every(p => (p.loadMs as number) <= THRESHOLD);
    const searchOk = search.ms !== null && search.ms <= THRESHOLD;

    let score = 0;
    if (homepageOk) score++;
    if (otherOk) score++;
    if (searchOk) score++;

    const parts = [
      `Homepage: ${fmt(homepage.loadMs)} ${homepageOk ? '✓ [1]' : '✗ [0]'}`,
      `Other pages (${otherMeasured.length} sampled, slowest ${fmt(otherMeasured.length ? Math.max(...otherMeasured.map(p => p.loadMs as number)) : null)}): ${otherOk ? '✓ [1]' : '✗ [0]'}`,
      `Search results: ${fmt(search.ms)} ${searchOk ? '✓ [1]' : search.ms === null ? '— not measurable [0]' : '✗ [0]'}`,
    ];

    const ss = ssPath(auditJobId, '67');
    await viewportShot(page, ss.abs);

    results.push(makeResult('Q67', {
      scoreEarned: score,
      status: score === 3 ? 'pass' : score > 0 ? 'partial' : 'fail',
      screenshotPath: ss.rel,
      notes: `3-second load check (full load event): ${parts.join(' | ')}.${search.ms === null ? ` ${search.note}` : ''}`,
      recommendation: score === 3 ? '' : getRecommendation('Q67'),
    }));
  }

  return results;
}
