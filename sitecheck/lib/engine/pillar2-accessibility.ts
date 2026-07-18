// lib/engine/pillar2-accessibility.ts — Q4, Q5, Q6, Q7, Q8, Q9, Q10
// Accessibility & Inclusion pillar
// EVIDENCE RULES: 
// - No cropped screenshots. Always use full-page or large viewport.
// - Highlight evidence programmatically using DOM overlays.

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeScreenshot, takeHighlightedScreenshot, dismissCookieBanner, openNavMenu } from '@/lib/engine/helpers';
import { clickWithHighlight, humanScrollVerify, type EvidenceRecorder } from '@/lib/engine/recording';

const PILLAR = 'Accessibility & Inclusion';

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

// ── helper: internal-page targets a human would click ──
// Same-origin content links, EXCLUDING language-toggle links (`/en/`, `/ar/`,
// hreflang alternates, anchors whose text is a language name) and the pages
// we are already on. Viewport-visible links are preferred (they are what a
// human can click — e.g. links revealed by an opened hamburger drawer); when
// the switched page carries a locale prefix (`/ar/…`), links sharing it rank
// first so navigation preserves the switched language.
async function collectNavTargets(
  page: Page,
  max: number,
  excludeUrls: string[],
): Promise<Array<{ href: string; visible: boolean }>> {
  return page.evaluate(({ maxN, excludes }) => {
    const orig = location.origin;
    const current = location.href.split('#')[0];
    const langText = ['en', 'ar', 'english', 'عربي', 'العربية', 'français', 'urdu', 'hindi'];
    const localeRoot = /^\/[a-z]{2}(-[a-zA-Z]{2,4})?\/?$/;
    const localePrefixMatch = new URL(current).pathname.match(/^\/[a-z]{2}(-[a-zA-Z]{2,4})?\//);
    const localePrefix = localePrefixMatch ? localePrefixMatch[0] : null;

    const seen = new Set<string>();
    const out: Array<{ href: string; visible: boolean; sameLocale: boolean }> = [];
    for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
      const href = a.href;
      if (!href.startsWith(orig) || href === orig || href === orig + '/' || href.includes('#')) continue;
      const clean = href.split('#')[0];
      if (seen.has(clean) || clean === current) continue;
      if (excludes.some((u: string) => u && clean === u.split('#')[0])) continue;
      const path = new URL(clean).pathname;
      if (localeRoot.test(path)) continue; // `/en/`, `/ar/` — language toggles, not content
      if (a.hasAttribute('hreflang')) continue;
      const text = (a.textContent || '').trim().toLowerCase();
      if (langText.includes(text)) continue;

      const r = a.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 &&
        r.top >= 0 && r.bottom <= window.innerHeight &&
        r.left >= 0 && r.right <= window.innerWidth;
      seen.add(clean);
      out.push({ href: clean, visible, sameLocale: localePrefix ? path.startsWith(localePrefix) : true });
    }
    out.sort((a, b) =>
      Number(b.visible) - Number(a.visible) ||
      Number(b.sameLocale) - Number(a.sameLocale));
    return out.slice(0, maxN).map(({ href, visible }) => ({ href, visible }));
  }, { maxN: max, excludes: excludeUrls }).catch(() => []);
}

// ── helper: discover same-origin links ──
async function discoverInternalLinks(page: Page, url: string, max = 3): Promise<string[]> {
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

// Use extremely targeted selectors to prevent highlighting generic nav links or huge wrapper divs.
const STRICT_LANG_SELECTORS = [
  'button:has-text("English")', 'button:has-text("عربي")', 'button:has-text("العربية")', 'button:has-text("Français")',
  'a:has-text("English")', 'a:has-text("عربي")', 'a:has-text("العربية")', 'a:has-text("Français")',
  'a:has-text("AR")', 'a:has-text("EN")',
  'button:has-text("AR")', 'button:has-text("EN")',
  '[aria-label*="English" i]', '[aria-label*="عربي"]', '[aria-label*="العربية"]',
  '[aria-label*="Language" i]', '[title*="Language" i]',
  '[aria-label*="اللغة"]', '[title*="اللغة"]',
  'select[id*="lang" i]', 'select[class*="lang" i]'
];

// Broad selectors just to detect existence if the exact text isn't matched
const BROAD_LANG_SELECTORS = [
  'a[href*="/ar"]', 'a[href*="/en"]', 'a[hreflang]',
  '[class*="lang"]', '[id*="lang"]', '[class*="language"]', '[id*="language"]',
  'select[class*="lang"]', 'select[id*="lang"]', '[data-lang]'
];

// ────────────────────────────────────────────────────────────
//  Language-switch journey (Q5/Q6 evidence)
//  The switcher behavior — Direct Toggle (click = instant language change,
//  like Mubadala) vs Menu Opener (click = dropdown/panel, like Tamm) — is
//  discovered LIVE during the recorded journey: one deliberate click,
//  observe, react. No off-camera probe-and-restore pass.
// ────────────────────────────────────────────────────────────

interface SwitchBehavior {
  type: 'direct-toggle' | 'menu-opener' | 'unknown';
  clickedSelector: string | null;
}

interface LangState { lang: string; dir: string; url: string; text: string }

interface LangJourney {
  behavior: SwitchBehavior;
  switched: boolean;
  switchMethod: string;
  initialState: LangState;
  finalState: LangState;
  textChanged: boolean;
  langChanged: boolean;
  dirChanged: boolean;
  /** Whether the journey already wrote q5.png (control or revealed panel). */
  q5EvidenceTaken: boolean;
}

function getLangStateInPage(): { lang: string; dir: string; url: string; text: string } {
  const html = document.documentElement;
  const body = document.body;
  return {
    lang: html.lang || '',
    dir: html.dir || body.dir || window.getComputedStyle(body).direction || '',
    url: location.href,
    text: body.innerText.substring(0, 1000),
  };
}

const hasArabicText = (text: string) => /[؀-ۿ]/.test(text);

// Language keywords a revealed panel must contain to qualify.
const PANEL_LANG_KEYWORDS = ['english', 'عربي', 'العربية', 'language', 'اللغة', 'français'];

/**
 * After a click on the language button, find and highlight the revealed
 * panel/banner as "Language Control". Three strategies, in order:
 *  1. Newly-visible container diff (elements missing the pre-click
 *     `data-sitecheck-prevvis` marker) — class-name independent
 *  2. Known panel selectors (dialog/modal/dropdown/menu…) with the size cap
 *     relaxed so full-width banners (TAMM) qualify
 *  3. Nearest ancestor of the clicked button holding >=2 language options —
 *     the whole banner is highlighted
 */
async function highlightLanguagePanel(page: Page, clickedSelector: string): Promise<boolean> {
  return page.evaluate(({ clickedSel, keywords }) => {
    const vpH = window.innerHeight;
    const isVisible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const hasLangText = (el: HTMLElement) => {
      const text = (el.innerText || '').toLowerCase();
      return keywords.some((k: string) => text.includes(k));
    };
    const qualifies = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      // Full-width banners are allowed; only reject near-full-page overlays.
      return r.width >= 50 && r.height >= 40 && r.height < vpH * 0.95;
    };

    let panel: HTMLElement | null = null;

    // 1. Containers that became visible after the click
    const fresh = (Array.from(
      document.querySelectorAll('div, section, ul, nav, aside, dialog')
    ) as HTMLElement[]).filter(el =>
      !el.hasAttribute('data-sitecheck-prevvis') &&
      isVisible(el) && qualifies(el) && hasLangText(el)
    );
    // Prefer the outermost fresh container (the whole banner, not a child row)
    panel = fresh.find(el => !fresh.some(o => o !== el && o.contains(el))) || fresh[0] || null;

    // 2. Known panel selectors, size caps relaxed
    if (!panel) {
      const panelSelectors = [
        'dialog[open]', '[role="dialog"]', '[role="alertdialog"]',
        '[class*="modal"]:not([style*="display: none"]):not([style*="display:none"])',
        '[class*="dialog"]:not([style*="display: none"]):not([style*="display:none"])',
        '[class*="popup"]:not([style*="display: none"])',
        '[class*="popover"]:not([style*="display: none"])',
        '[class*="overlay"]:not([style*="display: none"])',
        '[class*="dropdown"][class*="lang"]',
        '[class*="language-menu"]', '[class*="lang-menu"]',
        '[class*="lang-select"]', '[class*="locale"]',
        '[role="menu"]', '[role="listbox"]',
        'ul[class*="lang"]', 'div[class*="lang-drop"]',
        '[class*="dropdown"]:not([style*="display: none"])',
        '[class*="submenu"]:not([style*="display: none"])',
      ];
      for (const sel of panelSelectors) {
        try {
          for (const c of document.querySelectorAll(sel)) {
            const el = c as HTMLElement;
            if (!isVisible(el) || !qualifies(el)) continue;
            if (hasLangText(el) || sel.includes('dialog') || sel.includes('modal') || sel.includes('overlay')) {
              panel = el;
              break;
            }
          }
        } catch { /* skip invalid selector */ }
        if (panel) break;
      }
    }

    // 3. Whole-banner fallback: walk up from the clicked button
    if (!panel) {
      const btn = document.querySelector(clickedSel) as HTMLElement | null;
      let cur = btn ? btn.parentElement : null;
      while (cur && cur !== document.body) {
        const optionCount = (Array.from(
          cur.querySelectorAll('a, button, li, [role="option"], [data-lang]')
        ) as HTMLElement[]).filter(el => isVisible(el) && hasLangText(el)).length;
        if (optionCount >= 2 && qualifies(cur)) { panel = cur; break; }
        cur = cur.parentElement;
      }
    }

    if (!panel) return false;
    panel.setAttribute('data-sitecheck-q5-panel', '1');
    panel.style.outline = '4px solid red';
    panel.style.outlineOffset = '2px';
    panel.style.boxShadow = '0 0 20px rgba(255, 0, 0, 0.5)';
    const label = document.createElement('div');
    label.textContent = 'Language Control';
    label.id = 'sitecheck-q5-label';
    label.style.cssText = 'position:absolute; background:red; color:white; padding:4px 8px; font-size:14px; font-weight:bold; border-radius:4px; z-index:999999; pointer-events:none;';
    document.body.appendChild(label);
    const rect = panel.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    let top = rect.top + window.scrollY - labelRect.height - 8;
    if (rect.top < labelRect.height + 10) top = rect.bottom + window.scrollY + 8;
    label.style.top = `${top}px`;
    label.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
    return true;
  }, { clickedSel: clickedSelector, keywords: PANEL_LANG_KEYWORDS }).catch(() => false);
}

async function cleanupLanguagePanelHighlight(page: Page): Promise<void> {
  await page.evaluate(() => {
    const label = document.getElementById('sitecheck-q5-label');
    if (label) label.remove();
    document.querySelectorAll('[data-sitecheck-q5-panel]').forEach(el => {
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.boxShadow = '';
      el.removeAttribute('data-sitecheck-q5-panel');
    });
  }).catch(() => {});
}

/**
 * Undo the language switch: language choices persist in web storage and
 * cookies (e.g. TAMM's locale cookie), so a plain reload is not enough.
 * Clears both, reloads the original URL, and re-dismisses any cookie banner
 * the cleared consent brings back. Best-effort.
 */
async function restoreOriginalLanguage(page: Page, url: string): Promise<void> {
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* */ }
  }).catch(() => {});
  try { await page.context().clearCookies(); } catch { /* best-effort */ }
  await navigateAndWait(page, url);
  await dismissCookieBanner(page);
}

/**
 * The on-camera language journey: locate the switcher, highlight it for 1s,
 * click once and react to what actually happens — language changed (direct
 * toggle) or a panel opened (menu opener → highlight the whole banner, then
 * pick the target language with another 1s-hold click). Writes q5.png as a
 * side effect. Leaves the page on the translated site when switched, or reset
 * to the original URL when a panel opened but no switch was confirmed.
 */
async function runLanguageJourney(
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<LangJourney> {
  const initialState = await page.evaluate(getLangStateInPage);
  const journey: LangJourney = {
    behavior: { type: 'unknown', clickedSelector: null },
    switched: false,
    switchMethod: '',
    initialState,
    finalState: initialState,
    textChanged: false,
    langChanged: false,
    dirChanged: false,
    q5EvidenceTaken: false,
  };
  const initialArabic = hasArabicText(initialState.text);
  const targetKeywords = initialArabic ? ['English', 'EN', 'Français'] : ['عربي', 'العربية', 'AR'];

  const checkTranslated = async () => {
    const newState = await page.evaluate(getLangStateInPage);
    let signals = 0;
    let nonUrlSignals = 0;
    if (initialState.lang !== newState.lang && newState.lang !== '') { signals++; nonUrlSignals++; }
    if (initialState.dir !== newState.dir && newState.dir !== '') { signals++; nonUrlSignals++; }
    if (newState.url.split('?')[0] !== initialState.url.split('?')[0]) signals++;
    if (initialArabic !== hasArabicText(newState.text)) { signals++; nonUrlSignals++; }
    // A URL change alone is any navigation (e.g. an incidental content link
    // whose text contains a language word) — a real language switch must also
    // move the lang attribute, direction, or the script of the content.
    return { isTranslated: nonUrlSignals >= 1, newState, signals };
  };
  const recordSwitch = (method: string, res: { newState: LangState; signals: number }) => {
    journey.switched = true;
    journey.switchMethod = `${method} (${res.signals} signals)`;
    journey.finalState = res.newState;
    journey.langChanged = initialState.lang !== res.newState.lang;
    journey.dirChanged = initialState.dir !== res.newState.dir;
    journey.textChanged = initialArabic !== hasArabicText(res.newState.text);
  };

  try {
    // Locate the language control like a human would: it must be clickable
    // in the viewport (hidden drawer links report a box but can't be clicked),
    // and header-area controls win over incidental content links (on an
    // Arabic-default site, `a:has-text("عربي")` matches news articles too).
    const vp = page.viewportSize();
    let controlSel: string | null = null;
    let belowHeaderSel: string | null = null;
    for (const sel of STRICT_LANG_SELECTORS) {
      const loc = page.locator(sel).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (!box || box.width < 5 || box.height < 5) continue;
      const inViewport = box.x >= 0 && box.y >= 0 &&
        (!vp || (box.x + box.width <= vp.width && box.y + box.height <= vp.height));
      if (!inViewport) continue;
      if (box.y < 300) { controlSel = sel; break; }
      if (!belowHeaderSel) belowHeaderSel = sel;
    }
    if (!controlSel) controlSel = belowHeaderSel;
    if (!controlSel) return journey;
    const isSelect =
      (await page.locator(controlSel).first().evaluate(e => e.tagName.toLowerCase()).catch(() => '')) === 'select';

    await recorder?.setCaption('Q5/Q6 — Testing the language switch…');

    // Q5 provisional evidence: the control itself, highlighted. Overwritten
    // with the revealed panel below if the control turns out to be a menu opener.
    const q5ss = ssPath(auditJobId, '5');
    await takeHighlightedScreenshot(page, q5ss.abs, [controlSel], {
      contextualZoom: true,
      label: 'Language Control',
      maxHighlightBox: { width: 300, height: 100 },
    });
    journey.q5EvidenceTaken = true;

    const loc = page.locator(controlSel).first();

    if (isSelect) {
      // <select> switcher: highlight 1s, then choose the target option
      const options = await loc.locator('option').allTextContents().catch(() => [] as string[]);
      const targetOpt = options.find(o => targetKeywords.some(kw => o.includes(kw)));
      if (!targetOpt) return journey;
      await loc.evaluate(el => { (el as HTMLElement).style.outline = '4px solid red'; }).catch(() => {});
      await page.waitForTimeout(1000);
      await loc.selectOption({ label: targetOpt }).catch(() => {});
      await loc.evaluate(el => { (el as HTMLElement).style.outline = ''; }).catch(() => {});
      await page.waitForTimeout(2500);
      try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
      const res = await checkTranslated();
      if (res.isTranslated) {
        journey.behavior = { type: 'direct-toggle', clickedSelector: controlSel };
        recordSwitch(`Select-based switcher via ${controlSel}`, res);
      }
      return journey;
    }

    // Mark currently-visible containers so a newly-revealed panel can be diffed out
    await page.evaluate(() => {
      document.querySelectorAll('div, section, ul, nav, aside, dialog').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) el.setAttribute('data-sitecheck-prevvis', '1');
      });
    }).catch(() => {});

    // The one deliberate click: highlight-hold 1s, click, observe
    await clickWithHighlight(loc, { holdMs: 1000, timeout: 5000 });
    await page.waitForTimeout(2500);
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}

    const res = await checkTranslated();
    if (res.isTranslated) {
      journey.behavior = { type: 'direct-toggle', clickedSelector: controlSel };
      recordSwitch(`Direct toggle via ${controlSel}`, res);
      return journey;
    }

    // No switch — did a language panel/banner open instead? (TAMM case)
    const panelHighlighted = await highlightLanguagePanel(page, controlSel);
    if (panelHighlighted) {
      journey.behavior = { type: 'menu-opener', clickedSelector: controlSel };
      // Q5 evidence becomes the whole revealed panel, highlighted
      await page.waitForTimeout(500);
      await viewportShot(page, q5ss.abs);
      await cleanupLanguagePanelHighlight(page);

      // Pick the target language inside the open panel: highlight 1s, click
      for (const sel of STRICT_LANG_SELECTORS) {
        if (sel.includes('Language') || sel.includes('اللغة') || sel.includes('lang')) continue;
        if (!targetKeywords.some(kw => sel.includes(kw))) continue;
        const optLoc = page.locator(sel).first();
        if (!(await optLoc.isVisible().catch(() => false))) continue;
        try {
          await clickWithHighlight(optLoc, { holdMs: 1000, timeout: 5000 });
          await page.waitForTimeout(2500);
          try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
          const res2 = await checkTranslated();
          if (res2.isTranslated) {
            recordSwitch(`Menu opener: opened via ${controlSel}, selected target language`, res2);
          }
          break;
        } catch { /* try next option */ }
      }

      if (!journey.switched) {
        // Close the panel and reset so Q6's fallback pass starts clean
        try { await page.keyboard.press('Escape'); } catch {}
        try { await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }); } catch {}
        await page.waitForTimeout(2000);
      }
    } else if (page.url().split('#')[0] !== initialState.url.split('#')[0]) {
      // Neither a switch nor a panel, but the click navigated somewhere (an
      // incidental link) — reset to the audit URL before Q5/Q6 continue.
      try { await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }); } catch { /* */ }
      await page.waitForTimeout(2000);
    }
  } catch (err) {
    console.warn('[SiteCheck] Language journey error:', err);
  } finally {
    // The prevvis markers are DOM litter — clear them wherever we ended up
    await page.evaluate(() => {
      document.querySelectorAll('[data-sitecheck-prevvis]').forEach(el => el.removeAttribute('data-sitecheck-prevvis'));
    }).catch(() => {});
  }
  return journey;
}

// ────────────────────────────────────────────────────────────
//  Q4 — Multilingual Support
//  "Capture a medium-zoom screenshot centered on the website header or the language-selection panel...
//   Highlight only the actual language switcher control... Do not highlight generic page content."
// ────────────────────────────────────────────────────────────
async function checkQ4(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {

    const ss = ssPath(auditJobId, '4');
    
    // Take a medium-zoom (header-level) screenshot highlighting the switcher.
    // maxHighlightBox prevents highlighting the entire header or <html> tag.
    const highlighted = await takeHighlightedScreenshot(page, ss.abs, STRICT_LANG_SELECTORS, { 
      contextualZoom: true, 
      label: "Language Switcher",
      maxHighlightBox: { width: 300, height: 100 }
    });

    const data = await page.evaluate((selectors) => {
      const body = document.body.innerHTML.toLowerCase();
      let foundSelector = null;
      for (const sel of selectors) {
        try {
          if (document.querySelector(sel)) { foundSelector = sel; break; }
        } catch { /* */ }
      }
      
      let textFound = false;
      if (!foundSelector) {
        const textIndicators = ['عربي', 'english', 'العربية', 'ar |', '| en', 'en |', '| ar'];
        for (const t of textIndicators) {
          if (body.includes(t)) { textFound = true; break; }
        }
      }
      const hreflangs = document.querySelectorAll('link[rel="alternate"][hreflang]');
      return { foundSelector, textFound, hasHreflang: hreflangs.length > 0 };
    }, [...STRICT_LANG_SELECTORS, ...BROAD_LANG_SELECTORS]);

    if (highlighted || data.foundSelector || data.textFound || data.hasHreflang) {
      return makeResult('Q4', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: 'Language switcher detected and highlighted in a contextual header-level screenshot.',
      });
    }
    return makeResult('Q4', {
      screenshotPath: ss.rel,
      notes: 'No language switcher or multilingual support detected.',
    });
  } catch (err: unknown) {
    return makeResult('Q4', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}


// ────────────────────────────────────────────────────────────
//  Q5 — Language Switching Easy (depends Q4)
//  Evidence is captured live during the language journey (runLanguageJourney):
//   - Direct Toggle: the button highlighted as the control (pre-click shot)
//   - Menu Opener:   the revealed panel/banner highlighted as "Language Control"
//  This function only builds the result from the journey outcome.
// ────────────────────────────────────────────────────────────
async function checkQ5(
  page: Page, auditJobId: string, q4Passed: boolean, journey: LangJourney,
): Promise<CriterionResult> {
  if (!q4Passed) {
    return makeResult('Q5', { status: 'skipped', notes: 'Skipped — Q4 did not pass.' });
  }
  try {
    const inHeaderOrNav = await page.evaluate(() => {
      const regions = document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]');
      for (const region of regions) {
        const html = region.innerHTML.toLowerCase();
        if (html.includes('lang') || html.includes('عربي') || html.includes('english') || html.includes('العربية') ||
            !!region.querySelector('a[href*="/ar"], a[href*="/en"], [data-lang], [class*="lang"]')) {
          return true;
        }
      }
      return false;
    });

    const ss = ssPath(auditJobId, '5');
    if (!journey.q5EvidenceTaken) {
      // Journey could not locate/interact with a switcher — fall back to a
      // static highlight of whatever strict selector matches.
      await takeHighlightedScreenshot(page, ss.abs, STRICT_LANG_SELECTORS, {
        contextualZoom: true,
        label: 'Language Control',
        maxHighlightBox: { width: 300, height: 100 },
      });
    }

    if (inHeaderOrNav) {
      const noteDetail = journey.behavior.type === 'direct-toggle'
        ? 'Language control is a direct toggle button in the header/navigation — clicking it immediately switches the language.'
        : journey.behavior.type === 'menu-opener'
          ? 'Language control is a dropdown/panel in the header/navigation — clicking the button reveals the language options (panel highlighted).'
          : 'Language switcher found in header/navigation — easy to find.';
      return makeResult('Q5', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: noteDetail,
      });
    }
    return makeResult('Q5', {
      screenshotPath: ss.rel,
      notes: 'Language switcher exists but not in header or navigation area.',
    });
  } catch (err: unknown) {
    return makeResult('Q5', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q6 — Language Switch All Pages (depends Q4)
//  The switch itself happens during the language journey; this check picks up
//  the outcome, runs a last-resort fallback pass if the journey could not
//  switch, then captures evidence and verifies persistence across internal
//  pages. Restores the original language at the end.
// ────────────────────────────────────────────────────────────
async function checkQ6(
  page: Page, url: string, auditJobId: string, q4Passed: boolean, journey: LangJourney,
  recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  if (!q4Passed) {
    return makeResult('Q6', { status: 'skipped', notes: 'Skipped — Q4 did not pass.' });
  }
  try {
    const getLangState = () => {
      const html = document.documentElement;
      const body = document.body;
      return {
        lang: html.lang || '',
        dir: html.dir || body.dir || window.getComputedStyle(body).direction || '',
        url: location.href,
        text: body.innerText.substring(0, 1000),
      };
    };

    // Language state tracking starts from the journey's pre-click snapshot —
    // the page may already be switched by the time this check runs.
    const initialState = journey.initialState;
    let switchMethod = journey.switchMethod;
    const hasArabic = (text: string) => /[\u0600-\u06FF]/.test(text);
    const initialArabic = hasArabic(initialState.text);
    const targetKeywords = initialArabic ? ['English', 'EN', 'Français'] : ['عربي', 'العربية', 'AR'];

    const checkTranslated = async (minSignals = 1) => {
      const newState = await page.evaluate(getLangState);
      let signals = 0;
      let nonUrlSignals = 0;
      if (initialState.lang !== newState.lang && newState.lang !== '') { signals++; nonUrlSignals++; }
      if (initialState.dir !== newState.dir && newState.dir !== '') { signals++; nonUrlSignals++; }
      if (newState.url.split('?')[0] !== initialState.url.split('?')[0]) signals++;
      const newArabic = hasArabic(newState.text);
      if (initialArabic !== newArabic) { signals++; nonUrlSignals++; }
      return {
        // URL change alone is any navigation, not proof of a language switch
        isTranslated: signals >= minSignals && nonUrlSignals >= 1,
        newState,
        textChanged: initialArabic !== newArabic,
        langChanged: initialState.lang !== newState.lang,
        dirChanged: initialState.dir !== newState.dir,
        signals,
      };
    };

    // Direct-toggle and menu-opener switches already happened live during the
    // language journey — `switched` reflects that on-camera outcome.
    let switched = journey.switched;
    let finalState = journey.finalState;
    let textChanged = journey.textChanged;
    let langChanged = journey.langChanged;
    let dirChanged = journey.dirChanged;

    // ── Fallback — the journey could not switch; try all locators ──
    if (!switched) {
      console.log('[SiteCheck] Q6 — Fallback: trying all language locators');
      await recorder?.setCaption('Q6 — Trying alternative language switchers…');
      for (const sel of STRICT_LANG_SELECTORS) {
        const loc = page.locator(sel).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        try {
          const tagName = await loc.evaluate(e => e.tagName.toLowerCase());
          if (tagName === 'select') {
            const options = await loc.locator('option').allTextContents();
            const targetOpt = options.find(o => targetKeywords.some(kw => o.includes(kw)));
            if (targetOpt) await loc.selectOption({ label: targetOpt });
          } else {
            await loc.click({ timeout: 2000 });
          }

          try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
          await page.waitForTimeout(1500);

          const res = await checkTranslated(1);
          if (res.isTranslated) {
            switched = true;
            switchMethod = `Fallback click via ${sel} (${res.signals} signals)`;
            finalState = res.newState;
            textChanged = res.textChanged;
            langChanged = res.langChanged;
            dirChanged = res.dirChanged;
            break;
          }

          // Maybe it opened a menu — try clicking target language
          for (const targetSel of STRICT_LANG_SELECTORS) {
            if (targetSel.includes('Language') || targetSel.includes('اللغة') || targetSel.includes('lang')) continue;
            const isTarget = targetKeywords.some(kw => targetSel.includes(kw));
            if (!isTarget) continue;
            const tLoc = page.locator(targetSel).first();
            if (await tLoc.isVisible().catch(() => false)) {
              try {
                await tLoc.click({ timeout: 2000 });
                try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
                await page.waitForTimeout(1500);
                const res2 = await checkTranslated(1);
                if (res2.isTranslated) {
                  switched = true;
                  switchMethod = `Fallback multi-step: opened ${sel}, selected ${targetSel} (${res2.signals} signals)`;
                  finalState = res2.newState;
                  textChanged = res2.textChanged;
                  langChanged = res2.langChanged;
                  dirChanged = res2.dirChanged;
                  break;
                }
              } catch { /* ignore */ }
            }
          }
          if (switched) break;

          // Reset for next attempt
          try { await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }); } catch {}
          await page.waitForTimeout(2000);
        } catch { /* ignore */ }
      }
    }

    // ── Not switched — fail ──
    if (!switched) {
      const ss = ssPath(auditJobId, '6');
      await takeScreenshot(page, ss.abs);
      return makeResult('Q6', {
        status: 'fail',
        scoreEarned: 0,
        screenshotPath: ss.rel,
        notes: 'Attempted to interact with language switchers, but could not confirm a successful language change.',
      });
    }

    // ── Human-like scroll verification of the translated page (video evidence) ──
    if (recorder) {
      await recorder.setCaption('Q6 — Language switched: verifying the translated page…');
      await humanScrollVerify(page);
    }
    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';

    // ── Take screenshot of the translated main page ──
    await dismissCookieBanner(page); // Clear any cookie banners before screenshot
    const mainSs = ssPath(auditJobId, '6');
    await page.evaluate((strictSels) => {
      let switcher: HTMLElement | null = null;
      for (const sel of strictSels) {
        try {
          const el = document.querySelector(sel) as HTMLElement;
          if (el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().width <= 300) {
            switcher = el; break;
          }
        } catch { /* */ }
      }
      if (switcher) {
        switcher.style.outline = '4px solid red';
        switcher.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';
      }
      const heading = document.querySelector('h1, h2, main h3') as HTMLElement;
      if (heading) {
        heading.style.outline = '4px solid blue';
        heading.style.boxShadow = '0 0 15px rgba(0, 0, 255, 0.5)';
        const l2 = document.createElement('div');
        l2.textContent = 'Translated Content';
        l2.className = 'sitecheck-q6-label';
        l2.style.cssText = 'position:absolute; background:blue; color:white; padding:4px 8px; font-weight:bold; z-index:999999; border-radius:4px;';
        document.body.appendChild(l2);
        const r2 = heading.getBoundingClientRect();
        const l2Rect = l2.getBoundingClientRect();
        let top2 = r2.top + window.scrollY - l2Rect.height - 8;
        let left2 = r2.left + window.scrollX;
        if (r2.top < l2Rect.height + 10) top2 = r2.bottom + window.scrollY + 8;
        if (r2.left + l2Rect.width > window.innerWidth) left2 = window.innerWidth + window.scrollX - l2Rect.width - 8;
        if (r2.left < 0) left2 = window.scrollX + 8;
        l2.style.top = `${top2}px`;
        l2.style.left = `${left2}px`;
      }
    }, STRICT_LANG_SELECTORS);
    await page.waitForTimeout(500);

    const viewport = page.viewportSize();
    if (viewport) {
      await page.screenshot({
        path: mainSs.abs,
        clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 800) },
      });
    } else {
      await page.screenshot({ path: mainSs.abs });
    }
    await page.evaluate(() => {
      document.querySelectorAll('.sitecheck-q6-label').forEach(e => e.remove());
    });

    // ── Check persistence across internal pages (navigate like a human) ──
    await recorder?.setCaption('Q6 — Checking the language persists on internal pages…');

    // Prefer links a human can actually click; when the site hides its
    // navigation behind a hamburger (e.g. ADMO's 3-dash menu), open it first.
    // Language-toggle links (`/en/`, `/ar/`) are excluded — visiting those
    // would wipe the switched language and fail the check for the wrong reason.
    const excludeUrls = [url, initialState.url, finalState.url];
    let targets = await collectNavTargets(page, 2, excludeUrls);
    if (targets.filter(t => t.visible).length < 2) {
      await recorder?.setCaption('Q6 — Opening the navigation menu…');
      const opened = await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
      if (opened) targets = await collectNavTargets(page, 2, excludeUrls);
    }
    if (targets.length === 0) {
      // Last resort: old DOM-order discovery (direct navigation)
      targets = (await discoverInternalLinks(page, page.url(), 2)).map(href => ({ href, visible: false }));
    }
    if (targets.length === 0) {
      await recorder?.setCaption('Q6 — Returning to the original language…');
      await restoreOriginalLanguage(page, url);
      return makeResult('Q6', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: mainSs.rel,
        notes: `Language switch confirmed (${switchMethod}). No internal links found to verify persistence, but main page switched successfully.${stampNote}`,
      });
    }

    // Click the on-page anchor when possible — human navigation keeps the
    // switched language the way a real visitor's session would. Re-opens the
    // burger menu on internal pages when the anchor is hidden. Falls back to
    // a direct goto if clicking isn't possible.
    const humanNavigate = async (href: string): Promise<void> => {
      try {
        const u = new URL(href);
        const sel = `a[href="${href}"], a[href="${u.pathname + u.search}"]`;
        let anchor = page.locator(sel).first();
        if (!(await anchor.isVisible().catch(() => false))) {
          await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
          anchor = page.locator(sel).first();
        }
        if (await anchor.isVisible().catch(() => false)) {
          // Menu links sometimes open new tabs — keep the journey in this page
          await anchor.evaluate(el => { (el as HTMLAnchorElement).target = '_self'; }).catch(() => {});
          await recorder?.setCaption('Q6 — Navigating to an internal page via the menu…');
          await clickWithHighlight(anchor, { holdMs: recorder ? 1000 : 300, timeout: 5000 });
          try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* */ }
          await page.waitForTimeout(1500);
          return;
        }
      } catch { /* fall through to direct navigation */ }
      await navigateAndWait(page, href);
    };

    let pagesChecked = 0;
    let pagesWithSwitcher = 0;
    const screenshots: string[] = [mainSs.rel];

    for (let i = 0; i < targets.length; i++) {
      try {
        await humanNavigate(targets[i].href);
        pagesChecked++;
        await page.waitForTimeout(1000);
        await dismissCookieBanner(page); // Clear any cookie banners on internal pages

        const pageState = await page.evaluate(getLangState);
        const isTranslated =
          (langChanged && pageState.lang === finalState.lang) ||
          (dirChanged && pageState.dir === finalState.dir) ||
          (textChanged && hasArabic(pageState.text) === hasArabic(finalState.text));

        const switcherStillPresent = await page.evaluate((sels) => {
          for (const sel of sels) {
            try { if (document.querySelector(sel)) return true; } catch { /* */ }
          }
          return false;
        }, [...STRICT_LANG_SELECTORS, ...BROAD_LANG_SELECTORS]);

        if (isTranslated && switcherStillPresent) pagesWithSwitcher++;

        const ss = ssPath(auditJobId, '6', `_page${i + 1}`);
        await page.evaluate((strictSels) => {
          let switcher: HTMLElement | null = null;
          for (const sel of strictSels) {
            try {
              const el = document.querySelector(sel) as HTMLElement;
              if (el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().width <= 300) {
                switcher = el; break;
              }
            } catch { /* */ }
          }
          if (switcher) {
            switcher.style.outline = '4px solid red';
            switcher.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';
          }
          const heading = document.querySelector('h1, h2, main h3') as HTMLElement;
          if (heading) {
            heading.style.outline = '4px solid blue';
            heading.style.boxShadow = '0 0 15px rgba(0, 0, 255, 0.5)';
            const l2 = document.createElement('div');
            l2.textContent = 'Translated Content';
            l2.className = 'sitecheck-q6-label';
            l2.style.cssText = 'position:absolute; background:blue; color:white; padding:4px 8px; font-weight:bold; z-index:999999; border-radius:4px;';
            document.body.appendChild(l2);
            const r2 = heading.getBoundingClientRect();
            const l2Rect = l2.getBoundingClientRect();
            let top2 = r2.top + window.scrollY - l2Rect.height - 8;
            let left2 = r2.left + window.scrollX;
            if (r2.top < l2Rect.height + 10) top2 = r2.bottom + window.scrollY + 8;
            if (r2.left + l2Rect.width > window.innerWidth) left2 = window.innerWidth + window.scrollX - l2Rect.width - 8;
            if (r2.left < 0) left2 = window.scrollX + 8;
            l2.style.top = `${top2}px`;
            l2.style.left = `${left2}px`;
          }
        }, STRICT_LANG_SELECTORS);

        await page.waitForTimeout(500);
        if (viewport) {
          await page.screenshot({
            path: ss.abs,
            clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 800) },
          });
        } else {
          await page.screenshot({ path: ss.abs });
        }
        await page.evaluate(() => {
          document.querySelectorAll('.sitecheck-q6-label').forEach(e => e.remove());
        });
        screenshots.push(ss.rel);
      } catch { /* skip failed navigation */ }
    }

    // Cleanup: navigate back to original URL (restores the original language)
    await recorder?.setCaption('Q6 — Returning to the original language…');
    await restoreOriginalLanguage(page, url);

    if (pagesChecked === 0) {
      return makeResult('Q6', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: mainSs.rel,
        notes: `Language switch confirmed (${switchMethod}). Could not navigate to internal pages but main page switched successfully.${stampNote}`,
      });
    }

    if (pagesWithSwitcher === pagesChecked) {
      return makeResult('Q6', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: mainSs.rel,
        notes: `Language switch confirmed (${switchMethod}). Translated state persisted across ${pagesChecked} internal pages.${stampNote}`,
      });
    }

    return makeResult('Q6', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: mainSs.rel,
      notes: `Language switch confirmed, but state was lost or switcher missing on ${pagesChecked - pagesWithSwitcher} of ${pagesChecked} internal pages.${stampNote}`,
    });
  } catch (err: unknown) {
    return makeResult('Q6', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Shared helpers for Q7–Q10 evidence shots
//  Same medium-zoom approach as Q4/Q5/Q6: capture the current
//  viewport (height capped at 800px) instead of the full page,
//  so the highlighted element stays large and readable.
// ────────────────────────────────────────────────────────────
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
    document.querySelectorAll('.sitecheck-p2-label').forEach(e => e.remove());
    document.querySelectorAll('[data-sitecheck-hl]').forEach(el => {
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.boxShadow = '';
      el.removeAttribute('data-sitecheck-hl');
    });
  }).catch(() => {});
}

// Find the first selector that matches a visible, reasonably-sized control.
// Returns the selector (for later click/highlight) or null.
async function findVisibleControl(
  page: Page,
  selectors: string[],
  maxBox: { width: number; height: number },
): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      const box = await loc.boundingBox();
      if (!box || box.width < 5 || box.height < 5) continue;
      if (box.width > maxBox.width || box.height > maxBox.height) continue;
      return sel;
    } catch { /* invalid selector — try next */ }
  }
  return null;
}

// Generic accessibility toolbar/widget openers (used by Q8 and Q10 when
// the specific control lives inside a collapsed accessibility panel).
const A11Y_WIDGET_SELECTORS = [
  'button[class*="accessibility"]', '[class*="accessibility"] button', '[id*="accessibility"] button',
  'button[aria-label*="accessibility" i]', '[aria-label*="إمكانية الوصول"]',
  'button[class*="a11y"]', '[class*="a11y-widget"]',
  '[class*="accessibility-widget"]', '[id*="accessibility-widget"]',
];

// ────────────────────────────────────────────────────────────
//  Q7 — Descriptive alt text (evidence-only, not scored)
//  "All images have descriptive alternative text.
//   Note: check the availability of text displayed when hovering over images."
//  Only visible content images count; images explicitly marked decorative
//  (empty alt, role=presentation, aria-hidden) are compliant by exclusion.
//  Hover text (title attribute) is accepted per the criterion note.
// ────────────────────────────────────────────────────────────
async function checkQ7(page: Page, auditJobId: string, recorder?: EvidenceRecorder): Promise<CriterionResult> {
  try {
    const data = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const isVisibleContent = (img: HTMLImageElement) => {
        const r = img.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return false;
        const s = window.getComputedStyle(img);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const isDecorative = (img: HTMLImageElement) =>
        img.getAttribute('role') === 'presentation' ||
        img.getAttribute('aria-hidden') === 'true' ||
        (img.hasAttribute('alt') && (img.getAttribute('alt') || '').trim() === '');
      const hasText = (img: HTMLImageElement) =>
        (img.getAttribute('alt') || '').trim() !== '' || (img.getAttribute('title') || '').trim() !== '';

      const visible = imgs.filter(isVisibleContent);
      const evaluable = visible.filter(i => !isDecorative(i));
      const withText = evaluable.filter(hasText);
      return {
        totalImages: imgs.length,
        visible: visible.length,
        decorative: visible.length - evaluable.length,
        evaluable: evaluable.length,
        withText: withText.length,
      };
    });

    const ss = ssPath(auditJobId, '7');

    // Locate an example image — one WITH alt text when passing, or one MISSING
    // alt text as failure evidence — tag it and report its document Y so the
    // recorded journey can scroll down to it like a human instead of jumping.
    const targetY = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(img => {
        const r = img.getBoundingClientRect();
        const s = window.getComputedStyle(img);
        return r.width >= 40 && r.height >= 40 && s.display !== 'none' && s.visibility !== 'hidden';
      });
      const withAlt = imgs.find(i => (i.getAttribute('alt') || '').trim() !== '' || (i.getAttribute('title') || '').trim() !== '');
      const withoutAlt = imgs.find(i => !i.hasAttribute('alt') && (i.getAttribute('title') || '').trim() === '');
      const target = withAlt || withoutAlt;
      if (!target) return null;
      target.setAttribute('data-sitecheck-q7target', '1');
      return target.getBoundingClientRect().top + window.scrollY;
    });

    if (targetY !== null && recorder) {
      await recorder.setCaption('Q7 — Scrolling to an example image to check its alt text…');
      try {
        for (let i = 0; i < 20; i++) {
          const reached = await page.evaluate(
            (y: number) => window.scrollY + window.innerHeight * 0.7 >= y, targetY,
          );
          if (reached) break;
          await page.mouse.wheel(0, 300);
          await page.waitForTimeout(350);
        }
      } catch { /* cosmetic */ }
    }

    // Highlight the tagged example image centered in the viewport
    await page.evaluate(() => {
      const target = document.querySelector('img[data-sitecheck-q7target]') as HTMLImageElement | null;
      if (!target) return;
      target.removeAttribute('data-sitecheck-q7target');

      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      target.setAttribute('data-sitecheck-hl', '1');
      target.style.outline = '4px solid red';
      target.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';

      const altText = (target.getAttribute('alt') || target.getAttribute('title') || '').trim();
      const label = document.createElement('div');
      label.className = 'sitecheck-p2-label';
      label.textContent = altText ? `ALT TEXT: "${altText}"` : 'MISSING ALT TEXT';
      label.style.cssText =
        `position:absolute; background:${altText ? '#000' : 'red'}; color:${altText ? '#0f0' : 'white'}; ` +
        'padding:4px 8px; font-size:14px; font-weight:bold; border-radius:4px; z-index:999999; pointer-events:none; max-width:80vw;';
      document.body.appendChild(label);

      const rect = target.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      let top = rect.top + window.scrollY - labelRect.height - 8;
      let left = rect.left + window.scrollX;
      if (rect.top < labelRect.height + 10) top = rect.bottom + window.scrollY + 8;
      if (left + labelRect.width > window.scrollX + window.innerWidth) {
        left = window.scrollX + window.innerWidth - labelRect.width - 8;
      }
      if (left < window.scrollX) left = window.scrollX + 8;
      label.style.top = `${top}px`;
      label.style.left = `${left}px`;
    });

    await page.waitForTimeout(500);
    // Medium-zoom shot — the example image is centered in the viewport,
    // NOT a full-page capture where it would shrink to a tiny speck.
    await viewportShot(page, ss.abs);
    await cleanupHighlights(page);

    if (data.totalImages === 0) {
      return makeResult('Q7', {
        status: 'na',
        screenshotPath: ss.rel,
        notes: 'No images found on the page to evaluate.',
      });
    }
    if (data.evaluable === 0) {
      return makeResult('Q7', {
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `All ${data.visible} visible images are explicitly marked decorative (empty alt / presentation role), which is compliant.`,
      });
    }

    const percentage = Math.round((data.withText / data.evaluable) * 100);
    const detail = `${data.withText} of ${data.evaluable} content images have descriptive alt/hover text (${percentage}%). ` +
      `Totals: ${data.totalImages} images, ${data.visible} visible, ${data.decorative} decorative excluded.`;

    if (percentage >= 80) {
      return makeResult('Q7', {
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Descriptive alternative text present. ${detail} Screenshot shows an example image with its alt text.`,
      });
    }
    return makeResult('Q7', {
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Descriptive alternative text incomplete. ${detail} Screenshot highlights an image missing alt text.`,
    });
  } catch (err) {
    return makeResult('Q7', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q8 — Text Resizing (3-tier per evaluator instruction, mirrors Q10)
//  Locate the text-resize control — or the accessibility (Aa) widget hosting
//  it — screenshot it highlighted, then CLICK it and measure whether the text
//  size actually changes:
//  functional [1] / present but not functional [0.5] / none [0]
// ────────────────────────────────────────────────────────────
const TEXT_RESIZE_SELECTORS = [
  'button:has-text("A+")', 'a:has-text("A+")', 'button:has-text("Aa")',
  '[aria-label*="increase" i][aria-label*="font" i]', '[aria-label*="increase" i][aria-label*="text" i]',
  '[aria-label*="تكبير"]', '[title*="تكبير"]', '[title*="increase" i]',
  '[class*="font-increase"]', '[class*="increase-font"]', '[id*="font-increase"]',
  '[class*="font-size"] button', '[class*="fontsize"] button', '[class*="text-size"] button',
  '[class*="font-size"]', '[class*="fontsize"]', '[class*="text-size"]', '[class*="textsize"]',
  '[id*="font-size"]', '[id*="fontsize"]', '[id*="text-size"]',
  '[aria-label*="font size" i]', '[aria-label*="text size" i]',
  '[title*="font size" i]', '[title*="text size" i]',
];

// Explicit "increase" options that may only appear inside an opened panel.
const TEXT_INCREASE_SELECTORS = [
  'button:has-text("A+")', 'a:has-text("A+")', 'button:has-text("A +")',
  '[aria-label*="increase" i]', '[title*="increase" i]',
  '[aria-label*="تكبير"]', '[title*="تكبير"]',
  '[class*="font-increase"]', '[class*="increase-font"]', '[id*="font-increase"]',
];

// Font-size sliders inside accessibility panels (e.g. TAMM's custom
// slider-sensor). Scoped to text-size/font/accessibility containers so page
// carousels with "slider" classes don't match.
const TEXT_SLIDER_SELECTORS = [
  '[class*="text-size"] input[type="range"]', '[class*="font"] input[type="range"]',
  'input[type="range"]',
  '[class*="text-size"] [aria-label*="slider" i]', '[class*="font-size"] [aria-label*="slider" i]',
  '[class*="accessibility"] [aria-label*="slider" i]', '[role="slider"]',
];

async function checkQ8(
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  try {
    const ss = ssPath(auditJobId, '8');
    const stampNote = () => (recorder ? ` [${recorder.stamp()}]` : '');
    await recorder?.setCaption('Q8 — Locating the text-resize control…');

    // Representative computed font sizes; any difference after clicking counts.
    const sampleFontSizes = () => page.evaluate(() => {
      const els = [
        document.documentElement, document.body,
        document.querySelector('p'), document.querySelector('h1'), document.querySelector('main'),
      ].filter(Boolean) as Element[];
      return els.map(el => window.getComputedStyle(el).fontSize).join('|');
    });

    let clickedSomething = false;

    // 1. A text-size control visible directly on the page
    let controlSel = await findVisibleControl(page, TEXT_RESIZE_SELECTORS, { width: 300, height: 120 });
    let label = 'Text Resize Control';

    // 2. Otherwise open the accessibility (Aa) widget and look for it inside
    if (!controlSel) {
      const widgetSel = await findVisibleControl(page, A11Y_WIDGET_SELECTORS, { width: 300, height: 300 });
      if (widgetSel) {
        const urlBefore = page.url();
        try {
          await recorder?.setCaption('Q8 — Opening the accessibility widget…');
          await clickWithHighlight(page.locator(widgetSel).first(), { holdMs: 1000, timeout: 5000 });
          clickedSomething = true;
          await page.waitForTimeout(1500);
        } catch { /* widget not clickable */ }
        if (page.url() !== urlBefore) {
          await navigateAndWait(page, url, { waitAfter: 2000 });
        } else {
          controlSel = await findVisibleControl(page, TEXT_RESIZE_SELECTORS, { width: 300, height: 120 });
          if (controlSel) {
            label = 'Accessibility — Text Size Control';
          } else {
            // Widget exists but no resize option could be operated inside it.
            await takeHighlightedScreenshot(page, ss.abs, [widgetSel], {
              contextualZoom: true,
              label: 'Accessibility Widget',
              maxHighlightBox: { width: 300, height: 300 },
            });
            await navigateAndWait(page, url, { waitAfter: 2000 });
            return makeResult('Q8', {
              scoreEarned: 0.5,
              status: 'partial',
              screenshotPath: ss.rel,
              notes: 'An accessibility widget is present, but no text-resize option could be operated inside it (available but not verified functional).' + stampNote(),
            });
          }
        }
      }
    }

    if (!controlSel) {
      await recorder?.setCaption('Q8 — No text-resize control found on this website');
      if (recorder) await page.waitForTimeout(1500);
      await viewportShot(page, ss.abs);
      if (clickedSomething) await navigateAndWait(page, url, { waitAfter: 2000 });
      return makeResult('Q8', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: 'No text resizing control (A+/A-, font-size setting, or accessibility menu) found on the page.' + stampNote(),
      });
    }

    // Evidence shot of the located control before interacting
    await takeHighlightedScreenshot(page, ss.abs, [controlSel], {
      contextualZoom: true,
      label,
      maxHighlightBox: { width: 300, height: 300 },
    });

    // Functional test: 1s highlight-hold, click, measure a real font-size change
    await recorder?.setCaption('Q8 — Clicking the text-resize control and checking the text size…');
    const before = await sampleFontSizes();
    let functional = false;
    try {
      await clickWithHighlight(page.locator(controlSel).first(), { holdMs: 1000, timeout: 5000 });
      clickedSomething = true;
      await page.waitForTimeout(1500);
      functional = (await sampleFontSizes()) !== before;

      if (!functional) {
        // The control may have opened a panel — look for an explicit A+/increase option inside
        const incSel = await findVisibleControl(page, TEXT_INCREASE_SELECTORS, { width: 300, height: 120 });
        if (incSel && incSel !== controlSel) {
          await clickWithHighlight(page.locator(incSel).first(), { holdMs: 1000, timeout: 5000 });
          await page.waitForTimeout(1500);
          functional = (await sampleFontSizes()) !== before;
        }
      }

      if (!functional) {
        // Or a font-size slider (e.g. TAMM) — click near one end, then the
        // other (RTL panels put "bigger" on the left).
        const urlBeforeSlider = page.url();
        const sliderSel = await findVisibleControl(page, TEXT_SLIDER_SELECTORS, { width: 500, height: 60 });
        if (sliderSel) {
          const sBox = await page.locator(sliderSel).first().boundingBox().catch(() => null);
          if (sBox) {
            for (const frac of [0.92, 0.08]) {
              await page.mouse.click(sBox.x + sBox.width * frac, sBox.y + sBox.height / 2).catch(() => {});
              await page.waitForTimeout(1200);
              if (page.url().split('#')[0] !== urlBeforeSlider.split('#')[0]) break; // clicked something that navigated — abort
              functional = (await sampleFontSizes()) !== before;
              if (functional) break;
            }
          }
        }
      }
    } catch { /* control not clickable */ }

    if (functional && recorder) {
      await recorder.setCaption('Q8 — Text size changed: verifying across the page…');
      await humanScrollVerify(page);
    }

    // Restore the original size — resize preferences usually persist in storage
    if (clickedSomething) {
      await page.evaluate(() => {
        try { localStorage.clear(); sessionStorage.clear(); } catch { /* */ }
      }).catch(() => {});
      await navigateAndWait(page, url, { waitAfter: 2000 });
    }

    if (functional) {
      return makeResult('Q8', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: 'Text resizing control found and verified functional — clicking it changed the page text size.' + stampNote(),
      });
    }
    return makeResult('Q8', {
      scoreEarned: 0.5,
      status: 'partial',
      screenshotPath: ss.rel,
      notes: 'Text resizing control is present but clicking it produced no measurable text-size change (available but not functional).' + stampNote(),
    });
  } catch (err: unknown) {
    return makeResult('Q8', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q9 — Screen Reader Compatibility
//  "Capture a normal page view where the text is selectable and structured...
//   Highlight the tested content area"
// ────────────────────────────────────────────────────────────
async function checkQ9(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const a11yData = await page.evaluate(() => {
      const semanticElements = document.querySelectorAll('nav, main, header, footer, article, section, aside').length;
      const hasLangAttr = !!document.documentElement.lang;
      const ariaLabels = document.querySelectorAll('[aria-label], [role]').length;
      return { semanticElements, hasLangAttr, ariaLabels };
    });

    const ss = ssPath(auditJobId, '9');

    // Highlight the main content area to prove text is structured,
    // then take a medium-zoom viewport shot (not full page).
    await page.evaluate(() => {
      const main = document.querySelector('main, article, .content, #content') as HTMLElement | null;
      if (!main) return;
      main.scrollIntoView({ behavior: 'instant', block: 'start' });
      main.setAttribute('data-sitecheck-hl', '1');
      main.style.outline = '4px solid green';
      main.style.boxShadow = '0 0 15px rgba(0, 255, 0, 0.5)';

      const label = document.createElement('div');
      label.className = 'sitecheck-p2-label';
      label.textContent = 'Structured Content Area';
      label.style.cssText =
        'position:absolute; background:green; color:white; padding:4px 8px; ' +
        'font-weight:bold; border-radius:4px; z-index:999999; pointer-events:none;';
      document.body.appendChild(label);

      const rect = main.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      let top = rect.top + window.scrollY - labelRect.height - 8;
      let left = rect.left + window.scrollX;
      // The content area is usually taller than the viewport — if there is no
      // room above it, place the label just INSIDE its top edge (not below the
      // whole element, which would fall outside the captured viewport).
      if (rect.top < labelRect.height + 10) top = rect.top + window.scrollY + 8;
      if (left + labelRect.width > window.scrollX + window.innerWidth) {
        left = window.scrollX + window.innerWidth - labelRect.width - 8;
      }
      if (left < window.scrollX) left = window.scrollX + 8;
      label.style.top = `${top}px`;
      label.style.left = `${left}px`;
    });

    await page.waitForTimeout(500);
    await viewportShot(page, ss.abs);
    await cleanupHighlights(page);

    const score = (a11yData.hasLangAttr && a11yData.semanticElements >= 2) ? 1 : 0;

    return makeResult('Q9', {
      scoreEarned: score,
      status: score === 1 ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Semantic elements: ${a11yData.semanticElements}, ARIA attributes: ${a11yData.ariaLabels}. ` +
             `Content area highlighted in screenshot.`,
    });
  } catch (err: unknown) {
    return makeResult('Q9', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q10 — Color Contrast Adjustment (3-tier per criteria sheet)
//  Yes, available AND functional [1] / available but NOT functional [0.5] / No [0]
//  Finds the control, screenshots it at contextual zoom (not full page),
//  then clicks it and measures whether the page colors actually change.
// ────────────────────────────────────────────────────────────
const CONTRAST_SELECTORS = [
  'button[class*="contrast"]', 'a[class*="contrast"]', 'button[id*="contrast"]',
  '[aria-label*="contrast" i]', '[title*="contrast" i]', '[aria-label*="التباين"]', '[title*="تباين"]',
  '[class*="high-contrast"]', '[class*="theme-toggle"]', '[class*="theme-switch"]', '[class*="theme-switcher"]',
  '[class*="dark-mode-toggle"]', 'button[class*="dark-mode"]', 'button[class*="darkmode"]',
  '[data-theme-toggle]', '[aria-label*="dark mode" i]',
  '[aria-label*="theme" i]', '[title*="theme" i]', '[aria-label*="dark" i]',
  '[class*="contrast"]', '[id*="contrast"]',
];

// Dark/contrast options that may only appear inside an opened theme menu.
const THEME_OPTION_SELECTORS = [
  'button:has-text("Dark")', '[role="menuitem"]:has-text("Dark")', 'li:has-text("Dark")',
  'a:has-text("Dark")', 'button:has-text("داكن")', '[role="menuitem"]:has-text("داكن")',
  'button:has-text("ليلي")', '[data-theme-value="dark"]',
];

async function checkQ10(
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  try {
    const stampNote = () => (recorder ? ` [${recorder.stamp()}]` : '');
    await recorder?.setCaption('Q10 — Locating a colour-contrast / theme control…');
    const sampleTheme = () => page.evaluate(() => ({
      bodyBg: window.getComputedStyle(document.body).backgroundColor,
      bodyColor: window.getComputedStyle(document.body).color,
      htmlFilter: window.getComputedStyle(document.documentElement).filter,
      dataTheme:
        (document.documentElement.getAttribute('data-theme') || '') + '|' +
        (document.body.getAttribute('data-theme') || ''),
    }));

    const ss = ssPath(auditJobId, '10');
    let clickedSomething = false;

    // 1. Look for a direct contrast/theme control on the page
    let controlSel = await findVisibleControl(page, CONTRAST_SELECTORS, { width: 300, height: 120 });

    // 2. If none, try opening an accessibility widget/toolbar and look inside it
    if (!controlSel) {
      const widgetSel = await findVisibleControl(page, A11Y_WIDGET_SELECTORS, { width: 300, height: 300 });
      if (widgetSel) {
        const urlBefore = page.url();
        try {
          await recorder?.setCaption('Q10 — Opening the accessibility widget…');
          await clickWithHighlight(page.locator(widgetSel).first(), { holdMs: 1000, timeout: 5000 });
          clickedSomething = true;
          await page.waitForTimeout(1500);
        } catch { /* widget not clickable */ }
        if (page.url() !== urlBefore) {
          await navigateAndWait(page, url, { waitAfter: 2000 });
        } else {
          controlSel = await findVisibleControl(page, CONTRAST_SELECTORS, { width: 300, height: 120 });
        }
      }
    }

    if (!controlSel) {
      // Narrate the absence on the recording before the evidence shot
      await recorder?.setCaption('Q10 — No colour/theme adjustment control found on this website');
      if (recorder) await page.waitForTimeout(2000);
      await viewportShot(page, ss.abs);
      if (clickedSomething) await navigateAndWait(page, url, { waitAfter: 2000 });
      return makeResult('Q10', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: 'No color contrast / theme adjustment control found on the page.' + stampNote(),
      });
    }

    // Screenshot the control at contextual zoom before interacting
    await takeHighlightedScreenshot(page, ss.abs, [controlSel], {
      contextualZoom: true,
      label: 'Contrast Control',
      maxHighlightBox: { width: 300, height: 120 },
    });

    // Functional test: 1s highlight-hold, click the control, measure color/theme change
    await recorder?.setCaption('Q10 — Clicking the contrast/theme control and checking the colours…');
    const before = await sampleTheme();
    let functional = false;
    try {
      await clickWithHighlight(page.locator(controlSel).first(), { holdMs: 1000, timeout: 5000 });
      clickedSomething = true;
      await page.waitForTimeout(1500);
      let after = await sampleTheme();
      functional =
        before.bodyBg !== after.bodyBg ||
        before.bodyColor !== after.bodyColor ||
        before.htmlFilter !== after.htmlFilter ||
        before.dataTheme !== after.dataTheme;

      if (!functional) {
        // The control may have opened a theme menu — pick an explicit dark option
        const optSel = await findVisibleControl(page, THEME_OPTION_SELECTORS, { width: 400, height: 120 });
        if (optSel) {
          await clickWithHighlight(page.locator(optSel).first(), { holdMs: 1000, timeout: 5000 });
          await page.waitForTimeout(1500);
          after = await sampleTheme();
          functional =
            before.bodyBg !== after.bodyBg ||
            before.bodyColor !== after.bodyColor ||
            before.htmlFilter !== after.htmlFilter ||
            before.dataTheme !== after.dataTheme;
        }
      }
    } catch { /* control not clickable */ }

    if (functional && recorder) {
      await recorder.setCaption('Q10 — Layout changed: verifying the new colours across the page…');
      await humanScrollVerify(page);
    }

    // Restore original state — theme choices usually persist in localStorage
    if (clickedSomething) {
      await page.evaluate(() => {
        try { localStorage.clear(); sessionStorage.clear(); } catch { /* */ }
      }).catch(() => {});
      await navigateAndWait(page, url, { waitAfter: 2000 });
    }

    if (functional) {
      return makeResult('Q10', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: 'Color contrast / theme control found and verified functional — clicking it changed the page colors.' + stampNote(),
      });
    }
    return makeResult('Q10', {
      scoreEarned: 0.5,
      status: 'partial',
      screenshotPath: ss.rel,
      notes: 'Contrast/theme control is present but clicking it produced no measurable color change (available but not functional).' + stampNote(),
    });
  } catch (err: unknown) {
    return makeResult('Q10', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Export — Pillar check function
// ────────────────────────────────────────────────────────────
export default async function pillar2Accessibility(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
  recorder?: EvidenceRecorder;
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, entityName, recorder } = params;
  const results: CriterionResult[] = [];

  await recorder?.setCaption(`Pillar 2 — Accessibility & Inclusion: automated check for "${entityName}"`);

  // Dismiss any cookie banners before starting checks
  await dismissCookieBanner(page);

  // Q4 first — Q5 and Q6 depend on it
  await recorder?.setCaption('Q4 — Locating the language switcher…');
  const q4 = await checkQ4(page, auditJobId);
  results.push(q4);

  const q4Passed = q4.status === 'pass';

  // The on-camera language journey discovers the switch behavior live
  // (direct toggle vs menu opener) and performs the actual switch for Q5/Q6.
  let journey: LangJourney | null = null;
  if (q4Passed) {
    console.log('[SiteCheck] Q4 passed — running the language-switch journey...');
    journey = await runLanguageJourney(page, url, auditJobId, recorder);
    console.log(`[SiteCheck] Language journey: ${journey.behavior.type} (selector: ${journey.behavior.clickedSelector}), switched: ${journey.switched}`);
  } else {
    journey = {
      behavior: { type: 'unknown', clickedSelector: null },
      switched: false,
      switchMethod: '',
      initialState: { lang: '', dir: '', url: '', text: '' },
      finalState: { lang: '', dir: '', url: '', text: '' },
      textChanged: false,
      langChanged: false,
      dirChanged: false,
      q5EvidenceTaken: false,
    };
  }

  results.push(await checkQ5(page, auditJobId, q4Passed, journey));
  results.push(await checkQ6(page, url, auditJobId, q4Passed, journey, recorder));

  // Independent checks
  await recorder?.setCaption('Q7 — Checking that images provide descriptive alt text…');
  results.push(await checkQ7(page, auditJobId, recorder));
  results.push(await checkQ8(page, url, auditJobId, recorder));
  await recorder?.setCaption('Q9 — Checking screen-reader compatibility (structure & semantics)…');
  results.push(await checkQ9(page, auditJobId));
  results.push(await checkQ10(page, url, auditJobId, recorder));

  await recorder?.setCaption('Pillar 2 — Accessibility & Inclusion: checks complete');

  return results;
}
