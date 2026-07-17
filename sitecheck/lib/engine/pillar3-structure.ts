// lib/engine/pillar3-structure.ts — Q14 (Consistent Layout), Q15 (Device Agnostic), Q15b (Visual Content)
//
// Journey-based like pillar 2: Q14 walks real pages through the navigation bar
// (or the burger menu on sites like ADMO) comparing the layout to the homepage;
// Q15b reviews images/videos across the pages already visited; Q15 re-walks the
// site at phone size verifying scalability. Execution order Q14 → Q15b → Q15
// keeps a single viewport flip on video; results return in Q14, Q15, Q15b order.

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import {
  navigateAndWait,
  takeScreenshot,
  dismissCookieBanner,
  openNavMenu,
} from '@/lib/engine/helpers';
import {
  clickWithHighlight,
  humanScrollVerify,
  type EvidenceRecorder,
} from '@/lib/engine/recording';

const PILLAR = 'Website Structure';

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

function ssPath(auditJobId: string, qid: string, suffix = '') {
  const fileName = `q${qid}${suffix}.png`;
  return {
    rel: `/screenshots/${auditJobId}/${fileName}`,
    abs: path.join(process.cwd(), 'public', 'screenshots', auditJobId, fileName),
  };
}

// Medium-zoom evidence shot: capture the current viewport (height capped at
// 800px) instead of the full page, so highlighted elements stay readable.
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

async function cleanupHighlights(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('.sitecheck-p3-label').forEach(e => e.remove());
    document.querySelectorAll('[data-sitecheck-hl]').forEach(el => {
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.boxShadow = '';
      el.removeAttribute('data-sitecheck-hl');
    });
  }).catch(() => {});
}

// Outline the shared header/navigation and pin a corner label — used by Q14
// on the homepage and again on an internal page to show the same layout.
async function highlightLayout(page: Page, labelText: string): Promise<void> {
  await page.evaluate((lbl: string) => {
    window.scrollTo(0, 0);
    const target = (document.querySelector('header, [role="banner"]') ||
      document.querySelector('nav, [role="navigation"]')) as HTMLElement | null;
    if (target) {
      target.setAttribute('data-sitecheck-hl', '1');
      target.style.outline = '4px solid red';
      target.style.outlineOffset = '-4px';
      target.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';
    }
    const label = document.createElement('div');
    label.className = 'sitecheck-p3-label';
    label.textContent = lbl;
    label.style.cssText =
      'position:fixed; top:8px; left:8px; background:red; color:white; padding:4px 8px; ' +
      'font-size:14px; font-weight:bold; border-radius:4px; z-index:999999; pointer-events:none;';
    document.body.appendChild(label);
  }, labelText).catch(() => {});
}

interface NavTarget {
  href: string;
  text: string;
  visible: boolean;
}

// Internal content pages a human would click for a layout comparison:
// same-origin links, excluding language toggles, sign-in/register pages (a
// legitimate layout exception per the evaluation criteria) and the pages we
// are already on. Viewport-visible links (the nav bar, or an opened burger
// drawer) rank first, then links that look like content pages (services,
// about, contact…), then DOM order.
async function collectContentNavTargets(
  page: Page,
  max: number,
  excludeUrls: string[],
): Promise<NavTarget[]> {
  return page.evaluate(({ maxN, excludes }) => {
    const orig = location.origin;
    const current = location.href.split('#')[0];
    const langText = ['en', 'ar', 'english', 'عربي', 'العربية', 'français', 'urdu', 'hindi'];
    const localeRoot = /^\/[a-z]{2}(-[a-zA-Z]{2,4})?\/?$/;
    const authRe = /log-?in|sign-?in|sign-?up|register|تسجيل الدخول|تسجيل دخول|دخول/i;
    const contentRe = /service|about|contact|media|news|program|initiative|خدمات|عن |اتصل|أخبار|مبادرات/i;

    const seen = new Set<string>();
    const out: Array<{ href: string; text: string; visible: boolean; content: boolean }> = [];
    for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      const href = a.href;
      if (!href.startsWith(orig) || href === orig || href === orig + '/' || href.includes('#')) continue;
      const clean = href.split('#')[0];
      if (seen.has(clean) || clean === current) continue;
      if (excludes.some((u: string) => u && clean === u.split('#')[0])) continue;
      const path = new URL(clean).pathname;
      if (localeRoot.test(path)) continue; // `/en/`, `/ar/` — language toggles, not content
      if (a.hasAttribute('hreflang')) continue;
      // First rendered line only — nested card anchors (title + description)
      // otherwise concatenate into labels like "ServicesLegal service"
      const text = ((a as HTMLElement).innerText || a.textContent || '')
        .trim().split('\n')[0].replace(/\s+/g, ' ').trim();
      if (langText.includes(text.toLowerCase())) continue;
      if (authRe.test(path) || authRe.test(text)) continue; // layout exception: auth pages

      const r = a.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 &&
        r.top >= 0 && r.bottom <= window.innerHeight &&
        r.left >= 0 && r.right <= window.innerWidth;
      seen.add(clean);
      out.push({ href: clean, text, visible, content: contentRe.test(path) || contentRe.test(text) });
    }
    out.sort((a, b) =>
      Number(b.visible) - Number(a.visible) ||
      Number(b.content) - Number(a.content));
    return out.slice(0, maxN).map(({ href, text, visible }) => ({ href, text, visible }));
  }, { maxN: max, excludes: excludeUrls }).catch(() => []);
}

// Last-resort target discovery when no clickable navigation is found: raw
// same-origin links in DOM order, still excluding auth pages.
async function discoverFallbackLinks(page: Page, url: string, max: number): Promise<string[]> {
  const origin = new URL(url).origin;
  const links: string[] = await page.evaluate((orig: string) => {
    const authRe = /log-?in|sign-?in|sign-?up|register|تسجيل الدخول|تسجيل دخول|دخول/i;
    const seen = new Set<string>();
    const results: string[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      const href = a.href;
      if (!href.startsWith(orig) || href === orig || href === orig + '/' || href.includes('#')) continue;
      if (seen.has(href) || authRe.test(href)) continue;
      seen.add(href);
      results.push(href);
    }
    return results;
  }, origin).catch(() => []);
  return links.slice(0, max);
}

// Click the on-page anchor when possible — human navigation the way a real
// visitor would move. Re-opens the burger menu when the anchor is hidden and
// keeps the journey in this page (menu links sometimes open new tabs). Falls
// back to a direct goto when clicking isn't possible.
async function humanNavigate(page: Page, href: string, recorder?: EvidenceRecorder): Promise<void> {
  try {
    const u = new URL(href);
    const sel = `a[href="${href}"], a[href="${u.pathname + u.search}"]`;
    let anchor = page.locator(sel).first();
    if (!(await anchor.isVisible().catch(() => false))) {
      await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
      anchor = page.locator(sel).first();
    }
    if (await anchor.isVisible().catch(() => false)) {
      await anchor.evaluate(el => { (el as HTMLAnchorElement).target = '_self'; }).catch(() => {});
      await clickWithHighlight(anchor, { holdMs: recorder ? 1000 : 300, timeout: 5000 });
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* */ }
      await page.waitForTimeout(1500);
      return;
    }
  } catch { /* fall through to direct navigation */ }
  await navigateAndWait(page, href);
}

// SPA pages (e.g. TAMM's Support) can present an empty document for several
// seconds after the navigation "completes" — wait until real content exists
// before judging the layout, else a blank frame reads as "layout differs".
async function waitForRender(page: Page, timeoutMs = 12000): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        !!document.querySelector('header, nav, footer, [role="banner"]') &&
        (document.body?.innerText || '').trim().length > 80,
      undefined,
      { timeout: timeoutMs },
    );
  } catch { /* judge whatever rendered */ }
  await page.waitForTimeout(800);
}

// ────────────────────────────────────────────────────────────
//  Layout signature (Q14) & media stats (Q15b)
// ────────────────────────────────────────────────────────────

interface LayoutSignature {
  hasHeader: boolean;
  hasNav: boolean;
  hasFooter: boolean;
  headerTag: string | null;
  headerClasses: string | null;
}

async function getLayoutSignature(page: Page): Promise<LayoutSignature> {
  return page.evaluate(() => {
    const header = document.querySelector('header, [role="banner"]');
    const nav = document.querySelector('nav, [role="navigation"]');
    const footer = document.querySelector('footer, [role="contentinfo"]');
    return {
      hasHeader: !!header,
      hasNav: !!nav,
      hasFooter: !!footer,
      headerTag: header?.tagName ?? null,
      headerClasses: (header?.className && typeof header.className === 'string') ? header.className : null,
    };
  });
}

// Supporting detail for the notes only — never part of the pass/fail decision
// (per-page active-state classes make strict class equality flaky).
function classOverlapPct(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (!ta.size || !tb.size) return null;
  let common = 0;
  ta.forEach(t => { if (tb.has(t)) common++; });
  return Math.round((common / Math.max(ta.size, tb.size)) * 100);
}

interface MediaStats {
  images: number;
  broken: number;
  upscaled: number;
  videos: number;
  embeds: number;
}

// Quick scan through the page so lazily-loaded images get a src before the
// media audit — image-heavy sites (e.g. ADMO's news grid) otherwise report
// every below-the-fold placeholder as "broken".
async function triggerLazyLoad(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      const el = document.scrollingElement || document.documentElement;
      const step = window.innerHeight;
      const maxY = Math.min(el.scrollHeight, step * 12);
      for (let y = 0; y <= maxY; y += step) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 150));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
  } catch { /* best-effort */ }
}

// Automation proxy for "clear, relevant, visually appealing": media must be
// present, load correctly (not broken) and not be badly upscaled (rendered far
// beyond natural resolution ⇒ blurry). Images with no source at all are lazy
// placeholders that never intersected the viewport — skip them entirely
// rather than misreport them as broken.
async function collectMediaStats(page: Page): Promise<MediaStats> {
  return page.evaluate(() => {
    const isVisible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width >= 80 && r.height >= 60 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const imgs = Array.from(document.querySelectorAll('img'))
      .filter(isVisible)
      .filter(i => !!(i.currentSrc || i.getAttribute('src')));
    const broken = imgs.filter(i => i.complete && i.naturalWidth === 0);
    const upscaled = imgs.filter(
      i => i.naturalWidth > 0 && i.getBoundingClientRect().width > i.naturalWidth * 1.5
    );
    const videos = Array.from(document.querySelectorAll('video')).filter(v => isVisible(v as HTMLElement)).length;
    const embeds = Array.from(document.querySelectorAll('iframe[src]')).filter(f =>
      /youtube|youtu\.be|vimeo|dailymotion|wistia|video/i.test((f as HTMLIFrameElement).src)
    ).length;
    return { images: imgs.length, broken: broken.length, upscaled: upscaled.length, videos, embeds };
  }).catch(() => ({ images: 0, broken: 0, upscaled: 0, videos: 0, embeds: 0 }));
}

function mediaTotal(m: MediaStats): number {
  return m.images + m.videos + m.embeds;
}

function mediaSummary(m: MediaStats): string {
  return `${m.images} images (${m.broken} broken, ${m.upscaled} upscaled/blurry), ` +
    `${m.videos} videos, ${m.embeds} video embeds`;
}

// Highlight the rank-th largest visible image/video (scrolled to center, red
// outline + label). No click — Q15b only reviews media. Returns false when no
// such media element exists.
async function highlightMediaAt(page: Page, rank: number, labelText: string): Promise<boolean> {
  const found = await page.evaluate(({ nth, lbl }) => {
    const isVisible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width >= 80 && r.height >= 60 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const candidates = [
      ...Array.from(document.querySelectorAll('img')),
      ...Array.from(document.querySelectorAll('video')),
    ].filter(el => isVisible(el as HTMLElement)) as HTMLElement[];
    if (candidates.length <= nth) return false;

    const target = candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[nth];

    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    target.setAttribute('data-sitecheck-hl', '1');
    target.style.outline = '4px solid red';
    target.style.outlineOffset = '-4px';
    target.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';

    const label = document.createElement('div');
    label.className = 'sitecheck-p3-label';
    label.textContent = lbl;
    label.style.cssText =
      'position:absolute; background:red; color:white; padding:4px 8px; font-size:14px; ' +
      'font-weight:bold; border-radius:4px; z-index:999999; pointer-events:none;';
    document.body.appendChild(label);

    const rect = target.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    let top = rect.top + window.scrollY - labelRect.height - 8;
    let left = rect.left + window.scrollX;
    if (rect.top < labelRect.height + 10) top = rect.top + window.scrollY + 8;
    if (left + labelRect.width > window.scrollX + window.innerWidth) {
      left = window.scrollX + window.innerWidth - labelRect.width - 8;
    }
    if (left < window.scrollX) left = window.scrollX + 8;
    label.style.top = `${top}px`;
    label.style.left = `${left}px`;
    return true;
  }, { nth: rank, lbl: labelText }).catch(() => false);
  return found;
}

interface VisitedPage {
  url: string;
  label: string;
  media: MediaStats;
}

// ────────────────────────────────────────────────────────────
//  Q14 — Consistent Layout (journey: homepage → nav/burger pages)
// ────────────────────────────────────────────────────────────
async function checkQ14(
  page: Page,
  url: string,
  auditJobId: string,
  recorder?: EvidenceRecorder,
): Promise<{ result: CriterionResult; visitedPages: VisitedPage[] }> {
  const visitedPages: VisitedPage[] = [];
  try {
    await recorder?.setCaption('Q14 — Checking layout consistency: homepage header/navigation…');
    const homeSig = await getLayoutSignature(page);
    const ss = ssPath(auditJobId, '14');

    // Homepage evidence shot with the shared header/navigation highlighted
    await highlightLayout(page, 'Homepage — Shared Header/Navigation');
    await page.waitForTimeout(recorder ? 1000 : 300);
    await viewportShot(page, ss.abs);
    await cleanupHighlights(page);
    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';

    // Show the whole homepage layout like a human scanning it
    if (recorder) await humanScrollVerify(page, { maxSteps: 6 });

    // Pages a human would open from the navigation bar; behind a burger menu
    // (e.g. ADMO's 3-dash control) when too few links are directly visible.
    let targets = await collectContentNavTargets(page, 2, [url]);
    let usedMenu = false;
    if (targets.filter(t => t.visible).length < 2) {
      await recorder?.setCaption('Q14 — Navigation links are behind a menu; opening it…');
      usedMenu = await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
      if (usedMenu) targets = await collectContentNavTargets(page, 2, [url]);
    }
    let navMethod = usedMenu ? 'via the burger menu' : 'via visible navigation links';
    if (targets.length === 0) {
      const fallback = await discoverFallbackLinks(page, url, 2);
      targets = fallback.map(href => ({ href, text: '', visible: false }));
      if (targets.length) {
        await recorder?.setCaption('Q14 — No menu control found; navigating directly to an internal page…');
        navMethod = 'via direct navigation (no clickable menu found)';
      }
    }

    let consistentCount = 0;
    let pagesChecked = 0;
    const pageNotes: string[] = [];

    for (let i = 0; i < targets.length; i++) {
      try {
        const label = targets[i].text.slice(0, 40) || 'an internal page';
        await recorder?.setCaption(`Q14 — Visiting ${label} to compare layout…`);
        await humanNavigate(page, targets[i].href, recorder);
        await waitForRender(page);
        await dismissCookieBanner(page);
        pagesChecked++;

        let pageSig = await getLayoutSignature(page);
        // A still-blank document can read as "everything missing" — give a
        // slow page one more chance before judging it.
        if (!pageSig.hasHeader && !pageSig.hasNav && !pageSig.hasFooter) {
          await page.waitForTimeout(4000);
          pageSig = await getLayoutSignature(page);
        }
        const diffs: string[] = [];
        if (pageSig.hasHeader !== homeSig.hasHeader) diffs.push('header');
        if (pageSig.hasNav !== homeSig.hasNav) diffs.push('nav');
        if (pageSig.hasFooter !== homeSig.hasFooter) diffs.push('footer');
        const isConsistent = diffs.length === 0;
        if (isConsistent) consistentCount++;

        const overlap = classOverlapPct(homeSig.headerClasses, pageSig.headerClasses);
        pageNotes.push(
          `"${label}": ${isConsistent ? 'same layout' : `layout differs (${diffs.join('/')} mismatch)`}` +
          (overlap !== null ? ` (${overlap}% header class match)` : '')
        );

        // Evidence shot on every visited page — a mismatch shot is the fail evidence
        const ssInt = ssPath(auditJobId, '14', `_page${i + 1}`);
        await highlightLayout(
          page,
          isConsistent ? 'Internal Page — Same Header/Navigation' : 'Internal Page — Layout Differs'
        );
        await page.waitForTimeout(recorder ? 1000 : 300);
        await viewportShot(page, ssInt.abs);
        await cleanupHighlights(page);
        if (recorder) await humanScrollVerify(page, { maxSteps: 5 });

        // Silently collect media stats for Q15b (no captions/highlights here)
        visitedPages.push({ url: page.url(), label, media: await collectMediaStats(page) });
      } catch { /* skip failed navigation */ }
    }

    await recorder?.setCaption('Q14 — Returning to the homepage…');
    await navigateAndWait(page, url);
    await dismissCookieBanner(page);

    const baseElements = [
      homeSig.hasHeader ? 'Header ✓' : 'Header ✗',
      homeSig.hasNav ? 'Nav ✓' : 'Nav ✗',
      homeSig.hasFooter ? 'Footer ✓' : 'Footer ✗',
    ].join(', ');
    const detail = pageNotes.length ? ` Pages (${navMethod}): ${pageNotes.join('; ')}.` : '';
    const exception = ' Sign-in/registration pages excluded (allowed layout exception).';

    if (!homeSig.hasHeader && !homeSig.hasNav && !homeSig.hasFooter) {
      return {
        result: makeResult('Q14', {
          screenshotPath: ss.rel,
          notes: `No standard layout elements (header/nav/footer) detected. ${baseElements}${stampNote}`,
        }),
        visitedPages,
      };
    }

    if (pagesChecked === 0 || consistentCount === pagesChecked) {
      return {
        result: makeResult('Q14', {
          scoreEarned: 1,
          status: 'pass',
          screenshotPath: ss.rel,
          notes: `Layout is consistent across ${pagesChecked + 1} pages. Homepage: ${baseElements}.${detail}${exception}${stampNote}`,
          recommendation: '',
        }),
        visitedPages,
      };
    }

    return {
      result: makeResult('Q14', {
        screenshotPath: ss.rel,
        notes: `Layout consistent on ${consistentCount}/${pagesChecked} internal pages. Homepage: ${baseElements}.${detail}${exception}${stampNote}`,
      }),
      visitedPages,
    };
  } catch (err: unknown) {
    return {
      result: makeResult('Q14', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` }),
      visitedPages,
    };
  }
}

// ────────────────────────────────────────────────────────────
//  Q15b — Clear, relevant, visually appealing images and videos
//  (evidence-only, not scored; journey: homepage + richest internal page)
// ────────────────────────────────────────────────────────────
async function checkQ15b(
  page: Page,
  url: string,
  auditJobId: string,
  recorder: EvidenceRecorder | undefined,
  visitedPages: VisitedPage[],
): Promise<CriterionResult> {
  try {
    await recorder?.setCaption('Q15b — Reviewing images and videos on the homepage…');
    await triggerLazyLoad(page);
    const homeMedia = await collectMediaStats(page);
    const ss = ssPath(auditJobId, '15b');
    const perPage: string[] = [`Homepage: ${mediaSummary(homeMedia)}`];

    // Highlight up to two prominent media elements (no clicks — review only)
    const first = await highlightMediaAt(page, 0, 'Visual Content');
    if (first) {
      await page.waitForTimeout(recorder ? 1000 : 500);
      await viewportShot(page, ss.abs);
      await cleanupHighlights(page);
      if (recorder) {
        const second = await highlightMediaAt(page, 1, 'Visual Content');
        if (second) {
          await page.waitForTimeout(1000);
          await cleanupHighlights(page);
        }
      }
    } else {
      await recorder?.setCaption('Q15b — No prominent images or videos found on the homepage');
      if (recorder) await page.waitForTimeout(1500);
      await viewportShot(page, ss.abs);
    }
    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    // Review the media-richest page discovered during the Q14 journey
    const richest = [...visitedPages].sort((a, b) => mediaTotal(b.media) - mediaTotal(a.media))[0];
    let internalMedia: MediaStats | null = null;
    if (richest) {
      try {
        await recorder?.setCaption('Q15b — Visiting an internal page to review its media…');
        await humanNavigate(page, richest.url, recorder);
        await waitForRender(page);
        await dismissCookieBanner(page);
        await triggerLazyLoad(page);
        internalMedia = await collectMediaStats(page);
        perPage.push(`"${richest.label}": ${mediaSummary(internalMedia)}`);

        const ssInt = ssPath(auditJobId, '15b', '_page1');
        const found = await highlightMediaAt(page, 0, 'Visual Content');
        if (found) {
          await page.waitForTimeout(recorder ? 1000 : 500);
          await viewportShot(page, ssInt.abs);
          await cleanupHighlights(page);
        } else {
          await recorder?.setCaption('Q15b — No prominent images or videos found on this page');
          if (recorder) await page.waitForTimeout(1500);
          await viewportShot(page, ssInt.abs);
        }
        if (recorder) await humanScrollVerify(page, { maxSteps: 5 });

        await recorder?.setCaption('Q15b — Returning to the homepage…');
        await navigateAndWait(page, url);
        await dismissCookieBanner(page);
      } catch { /* internal-page review is best-effort */ }
    }

    // Aggregate across every page seen (homepage + all Q14 pages + revisit)
    const all = [homeMedia, ...visitedPages.map(p => p.media), ...(internalMedia ? [internalMedia] : [])];
    const totals = all.reduce((acc, m) => ({
      images: acc.images + m.images,
      broken: acc.broken + m.broken,
      upscaled: acc.upscaled + m.upscaled,
      videos: acc.videos + m.videos,
      embeds: acc.embeds + m.embeds,
    }), { images: 0, broken: 0, upscaled: 0, videos: 0, embeds: 0 });
    const summary = perPage.join(' | ');

    if (mediaTotal(totals) === 0) {
      return makeResult('Q15b', {
        status: 'fail',
        screenshotPath: ss.rel,
        notes: `No prominent images or videos found on the pages reviewed. ${summary}${stampNote}`,
      });
    }

    const brokenOk = totals.broken === 0;
    const upscaledOk = totals.images === 0 || totals.upscaled / totals.images <= 0.3;

    if (brokenOk && upscaledOk) {
      return makeResult('Q15b', {
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Clear visual content in use — media loads correctly at appropriate resolution across the pages reviewed. ${summary}.${stampNote}`,
      });
    }
    return makeResult('Q15b', {
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Visual content has quality issues (broken or low-resolution/stretched media). ${summary}.${stampNote}`,
    });
  } catch (err: unknown) {
    return makeResult('Q15b', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q15 — Device agnostic (phone journey + tablet spot-check)
// ────────────────────────────────────────────────────────────
async function checkQ15(
  page: Page,
  url: string,
  auditJobId: string,
  recorder: EvidenceRecorder | undefined,
  fallbackUrls: string[],
): Promise<CriterionResult> {
  const originalViewport = page.viewportSize();
  try {
    // Viewport meta first, while still at desktop size
    const viewportData = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
      return { hasViewport: !!meta, content: meta?.content ?? '' };
    });

    const hasOverflow = () => page.evaluate(
      () => document.body.scrollWidth > window.innerWidth + 10 // 10px tolerance
    ).catch(() => false);

    // ── Phone journey (390×844, iPhone 12–15 class) ──
    await recorder?.setCaption('Q15 — Switching to a phone-size viewport (390×844) to test scalability…');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(recorder ? 1500 : 800);
    await dismissCookieBanner(page); // mobile layouts can re-show banners

    const pageResults: Array<{ label: string; overflow: boolean }> = [];
    const ss = ssPath(auditJobId, '15');
    pageResults.push({ label: 'Homepage (phone)', overflow: await hasOverflow() });
    await takeScreenshot(page, ss.abs);
    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';
    if (recorder) await humanScrollVerify(page); // verify the phone layout like a human

    // Move between pages the way a phone user would — through the burger menu
    await recorder?.setCaption('Q15 — Opening the menu on the phone layout…');
    const menuOpened = await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
    let targets = await collectContentNavTargets(page, 2, [url]);
    if (targets.length === 0 && fallbackUrls.length) {
      await recorder?.setCaption('Q15 — No menu control found on mobile; navigating directly…');
      targets = fallbackUrls.slice(0, 2).map(href => ({ href, text: '', visible: false }));
    }

    for (let i = 0; i < targets.length; i++) {
      try {
        const label = targets[i].text.slice(0, 40) || 'an internal page';
        await recorder?.setCaption(`Q15 — Visiting ${label} at phone size…`);
        await humanNavigate(page, targets[i].href, recorder);
        await waitForRender(page);
        await dismissCookieBanner(page);
        pageResults.push({ label: `"${label}" (phone)`, overflow: await hasOverflow() });
        await takeScreenshot(page, ssPath(auditJobId, '15', `_page${i + 1}`).abs);
        if (recorder) await humanScrollVerify(page, { maxSteps: 6 });
      } catch { /* skip failed navigation */ }
    }

    // ── Tablet spot-check on the homepage (criterion mentions tablets too) ──
    await recorder?.setCaption('Q15 — Quick tablet-size check (768×1024)…');
    await page.setViewportSize({ width: 768, height: 1024 });
    await navigateAndWait(page, url);
    await dismissCookieBanner(page);
    await page.waitForTimeout(recorder ? 1000 : 500);
    const tabletOverflow = await hasOverflow();
    pageResults.push({ label: 'Homepage (tablet)', overflow: tabletOverflow });
    await takeScreenshot(page, ssPath(auditJobId, '15', '_tablet').abs);

    // ── Restore the desktop view ──
    await recorder?.setCaption('Q15 — Restoring the desktop view…');
    await page.setViewportSize(originalViewport ?? { width: 1280, height: 720 });
    await page.waitForTimeout(recorder ? 1000 : 500);

    const notes: string[] = [];
    notes.push(`Viewport meta tag: ${viewportData.hasViewport ? 'Yes' : 'No'}`);
    if (viewportData.hasViewport) notes.push(`Content: "${viewportData.content}"`);
    for (const p of pageResults) {
      notes.push(`${p.label}: ${p.overflow ? 'horizontal overflow (problem)' : 'scales cleanly'}`);
    }
    if (!menuOpened && targets.length === 0) {
      notes.push('No navigable internal pages at phone size — homepage evidence only');
    }

    const passed = viewportData.hasViewport && pageResults.every(p => !p.overflow);

    return makeResult('Q15', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: notes.join(' | ') + stampNote,
      recommendation: passed ? '' : getRecommendation('Q15'),
    });
  } catch (err: unknown) {
    // Never leave the page at a mobile size for later checks
    await page.setViewportSize(originalViewport ?? { width: 1280, height: 720 }).catch(() => {});
    return makeResult('Q15', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar3Structure(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
  recorder?: EvidenceRecorder;
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, entityName, recorder } = params;

  await recorder?.setCaption(`Pillar 3 — Website Structure: automated check for "${entityName}"`);

  // Clear cookie banners before any evidence screenshots
  await dismissCookieBanner(page);

  // Run order Q14 → Q15b → Q15 keeps desktop checks together and flips the
  // viewport once (phone journey last); results return in canonical order.
  const { result: q14, visitedPages } = await checkQ14(page, url, auditJobId, recorder);
  const q15b = await checkQ15b(page, url, auditJobId, recorder, visitedPages);
  const q15 = await checkQ15(page, url, auditJobId, recorder, visitedPages.map(p => p.url));

  await recorder?.setCaption('Pillar 3 — Website Structure: checks complete');
  if (recorder) await page.waitForTimeout(1500);

  return [q14, q15, q15b];
}
