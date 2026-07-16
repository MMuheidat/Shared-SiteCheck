// lib/engine/pillar2-accessibility.ts — Q4, Q5, Q6, Q7, Q8, Q9, Q10
// Accessibility & Inclusion pillar
// EVIDENCE RULES: 
// - No cropped screenshots. Always use full-page or large viewport.
// - Highlight evidence programmatically using DOM overlays.

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeScreenshot, takeHighlightedScreenshot, dismissCookieBanner } from '@/lib/engine/helpers';

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
//  Detect whether the language switcher is a Direct Toggle
//  (click = instant language change, like Mubadala) or a
//  Menu Opener (click = dropdown/panel, like Tamm).
// ────────────────────────────────────────────────────────────

interface SwitchBehavior {
  type: 'direct-toggle' | 'menu-opener' | 'unknown';
  clickedSelector: string | null;
}

async function detectSwitchBehavior(
  page: Page,
  url: string,
): Promise<SwitchBehavior> {
  // Capture initial state
  const initialState = await page.evaluate(() => {
    const html = document.documentElement;
    return {
      lang: html.lang || '',
      dir: html.dir || document.body.dir || '',
      url: location.href,
      text: document.body.innerText.substring(0, 500),
    };
  });
  const hasArabic = (text: string) => /[\u0600-\u06FF]/.test(text);
  const initialArabic = hasArabic(initialState.text);

  // Try to click the first visible language button
  for (const sel of STRICT_LANG_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      try {
        const tagName = await loc.evaluate(e => e.tagName.toLowerCase());
        if (tagName === 'select') continue; // selects are always menu-like

        await loc.click({ timeout: 2000 });
        await page.waitForTimeout(2500);
        try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}

        // Check if the language actually changed (direct toggle)
        const newState = await page.evaluate(() => {
          const html = document.documentElement;
          return {
            lang: html.lang || '',
            dir: html.dir || document.body.dir || '',
            url: location.href,
            text: document.body.innerText.substring(0, 500),
          };
        });

        let signals = 0;
        if (initialState.lang !== newState.lang && newState.lang !== '') signals++;
        if (initialState.dir !== newState.dir && newState.dir !== '') signals++;
        if (newState.url.split('?')[0] !== initialState.url.split('?')[0]) signals++;
        if (initialArabic !== hasArabic(newState.text)) signals++;

        if (signals >= 1) {
          // Direct Toggle — language already changed. Go back to restore.
          console.log(`[SiteCheck] detectSwitchBehavior: Direct toggle detected via ${sel} (${signals} signals)`);
          try { await page.goBack({ waitUntil: 'networkidle', timeout: 10000 }); } catch {}
          await page.waitForTimeout(2000);
          // If goBack didn't restore, navigate explicitly
          const currentLang = await page.evaluate(() => document.documentElement.lang || '');
          if (currentLang !== initialState.lang) {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);
          }
          return { type: 'direct-toggle', clickedSelector: sel };
        }

        // Check if a dropdown/menu appeared instead
        const menuAppeared = await page.evaluate(() => {
          // Look for newly visible menus, dropdowns, popups
          const candidates = document.querySelectorAll(
            '[class*="dropdown"], [class*="lang-menu"], [class*="language-menu"], ' +
            '[class*="lang-select"], [class*="locale"], [role="menu"], [role="listbox"], ' +
            'ul[class*="lang"], div[class*="lang-drop"], [class*="submenu"], ' +
            '[class*="popup"], [class*="popover"]'
          );
          for (const c of candidates) {
            const rect = (c as HTMLElement).getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
          }
          // Also check if new language links became visible
          const langLinks = document.querySelectorAll(
            'a[href*="/ar"], a[href*="/en"], a[hreflang], [data-lang]'
          );
          let visibleLangLinks = 0;
          for (const l of langLinks) {
            const rect = (l as HTMLElement).getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) visibleLangLinks++;
          }
          return visibleLangLinks >= 2;
        });

        if (menuAppeared) {
          console.log(`[SiteCheck] detectSwitchBehavior: Menu opener detected via ${sel}`);
          // Close the menu by pressing Escape or clicking elsewhere, then reload
          try { await page.keyboard.press('Escape'); } catch {}
          await page.waitForTimeout(500);
          try { await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }); } catch {}
          await page.waitForTimeout(2000);
          return { type: 'menu-opener', clickedSelector: sel };
        }

        // Neither — reset and try next selector
        try { await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }); } catch {}
        await page.waitForTimeout(2000);
      } catch {
        // Click failed, try next
        try { await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }); } catch {}
        await page.waitForTimeout(1000);
      }
    }
  }

  console.log('[SiteCheck] detectSwitchBehavior: Could not determine behavior');
  return { type: 'unknown', clickedSelector: null };
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
//  Behavior varies based on switch type:
//   - Direct Toggle: highlight the same button as Q4 (the button IS the control)
//   - Menu Opener:   click the button to reveal the dropdown, then highlight the panel
// ────────────────────────────────────────────────────────────
async function checkQ5(
  page: Page, url: string, auditJobId: string, q4Passed: boolean, behavior: SwitchBehavior,
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

    if (behavior.type === 'direct-toggle') {
      // The button IS the control — highlight the same button as Q4
      console.log('[SiteCheck] Q5 — Direct toggle: highlighting the language button itself as the control.');
      await takeHighlightedScreenshot(page, ss.abs, STRICT_LANG_SELECTORS, {
        contextualZoom: true,
        label: 'Language Control',
        maxHighlightBox: { width: 300, height: 100 },
      });
    } else if (behavior.type === 'menu-opener' && behavior.clickedSelector) {
      // Click the button to open the dropdown, then highlight the panel
      console.log('[SiteCheck] Q5 — Menu opener: clicking button to reveal dropdown, then highlighting the panel.');
      try {
        const btn = page.locator(behavior.clickedSelector).first();
        if (await btn.isVisible()) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(2000);
        }
      } catch { /* ignore click error */ }

      // Find the newly-visible dialog/panel/modal and highlight it directly
      const panelHighlighted = await page.evaluate(() => {
        // Search for dialog/modal/panel elements that are now visible
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

        let panel: HTMLElement | null = null;

        for (const sel of panelSelectors) {
          try {
            const candidates = document.querySelectorAll(sel);
            for (const c of candidates) {
              const el = c as HTMLElement;
              const rect = el.getBoundingClientRect();
              // Must be visible and reasonably sized (not the whole page)
              if (rect.width > 50 && rect.height > 50 && rect.width < window.innerWidth * 0.9 && rect.height < window.innerHeight * 0.9) {
                // Check it actually contains language-related content
                const text = el.innerText?.toLowerCase() || '';
                if (text.includes('english') || text.includes('عربي') || text.includes('العربية') ||
                    text.includes('language') || text.includes('اللغة') || text.includes('lang') ||
                    text.includes('ar') || text.includes('en') || text.includes('français')) {
                  panel = el;
                  break;
                }
                // If it's a dialog/modal, it's likely the right one even without language text
                if (sel.includes('dialog') || sel.includes('modal') || sel.includes('overlay')) {
                  panel = el;
                  break;
                }
              }
            }
            if (panel) break;
          } catch { /* skip invalid selector */ }
        }

        if (panel) {
          panel.style.outline = '4px solid red';
          panel.style.outlineOffset = '2px';
          panel.style.boxShadow = '0 0 20px rgba(255, 0, 0, 0.5)';
          // Add label
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
        }
        return false;
      });

      if (panelHighlighted) {
        console.log('[SiteCheck] Q5 — Successfully highlighted the language panel/dialog.');
      } else {
        console.log('[SiteCheck] Q5 — Could not find panel element, taking screenshot of open menu as-is.');
      }

      // Take the screenshot (either with highlighted panel or just the open menu)
      await page.waitForTimeout(500);
      const viewport = page.viewportSize();
      if (viewport) {
        await page.screenshot({
          path: ss.abs,
          clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 800) },
        });
      } else {
        await page.screenshot({ path: ss.abs });
      }

      // Cleanup label and close the menu
      await page.evaluate(() => {
        const label = document.getElementById('sitecheck-q5-label');
        if (label) label.remove();
      });
      try { await page.keyboard.press('Escape'); } catch {}
      await page.waitForTimeout(500);
    } else {
      // Unknown — fallback to original behavior (highlight the button)
      await takeHighlightedScreenshot(page, ss.abs, STRICT_LANG_SELECTORS, {
        contextualZoom: true,
        label: 'Language Control',
        maxHighlightBox: { width: 300, height: 100 },
      });
    }

    if (inHeaderOrNav) {
      const noteDetail = behavior.type === 'direct-toggle'
        ? 'Language control is a direct toggle button in the header/navigation — clicking it immediately switches the language.'
        : behavior.type === 'menu-opener'
          ? 'Language control is a dropdown menu in the header/navigation — clicking the button reveals language options.'
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
//  Uses the detected switch behavior:
//   - Direct Toggle: click button → language changes immediately → screenshot
//   - Menu Opener:   click button → select language from dropdown → screenshot
//  Then checks persistence across internal pages.
// ────────────────────────────────────────────────────────────
async function checkQ6(
  page: Page, url: string, auditJobId: string, q4Passed: boolean, behavior: SwitchBehavior,
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

    const initialState = await page.evaluate(getLangState);
    let switchMethod = '';
    const hasArabic = (text: string) => /[\u0600-\u06FF]/.test(text);
    const initialArabic = hasArabic(initialState.text);
    const targetKeywords = initialArabic ? ['English', 'EN', 'Français'] : ['عربي', 'العربية', 'AR'];

    const checkTranslated = async (minSignals = 1) => {
      const newState = await page.evaluate(getLangState);
      let signals = 0;
      if (initialState.lang !== newState.lang && newState.lang !== '') signals++;
      if (initialState.dir !== newState.dir && newState.dir !== '') signals++;
      if (newState.url.split('?')[0] !== initialState.url.split('?')[0]) signals++;
      const newArabic = hasArabic(newState.text);
      if (initialArabic !== newArabic) signals++;
      return {
        isTranslated: signals >= minSignals,
        newState,
        textChanged: initialArabic !== newArabic,
        langChanged: initialState.lang !== newState.lang,
        dirChanged: initialState.dir !== newState.dir,
        signals,
      };
    };

    let switched = false;
    let finalState = initialState;
    let textChanged = false;
    let langChanged = false;
    let dirChanged = false;

    // ── Case 1: Direct Toggle ──
    if (behavior.type === 'direct-toggle' && behavior.clickedSelector) {
      console.log(`[SiteCheck] Q6 — Direct toggle: clicking ${behavior.clickedSelector}`);
      const btn = page.locator(behavior.clickedSelector).first();
      if (await btn.isVisible().catch(() => false)) {
        try {
          await btn.click({ timeout: 3000 });
          await page.waitForTimeout(2500);
          try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}

          const res = await checkTranslated(1); // Accept 1 signal for direct toggle
          if (res.isTranslated) {
            switched = true;
            switchMethod = `Direct toggle via ${behavior.clickedSelector} (${res.signals} signals)`;
            finalState = res.newState;
            textChanged = res.textChanged;
            langChanged = res.langChanged;
            dirChanged = res.dirChanged;
          }
        } catch { /* click failed */ }
      }
    }

    // ── Case 2: Menu Opener ──
    if (!switched && behavior.type === 'menu-opener' && behavior.clickedSelector) {
      console.log(`[SiteCheck] Q6 — Menu opener: clicking ${behavior.clickedSelector} to open dropdown`);
      const btn = page.locator(behavior.clickedSelector).first();
      if (await btn.isVisible().catch(() => false)) {
        try {
          await btn.click({ timeout: 3000 });
          await page.waitForTimeout(1500);

          // Now click the target language option from the dropdown
          let targetClicked = false;
          for (const sel of STRICT_LANG_SELECTORS) {
            if (sel.includes('Language') || sel.includes('اللغة') || sel.includes('lang')) continue;
            const isTarget = targetKeywords.some(kw => sel.includes(kw));
            if (isTarget) {
              const loc = page.locator(sel).first();
              if (await loc.isVisible().catch(() => false)) {
                try {
                  const tagName = await loc.evaluate(e => e.tagName.toLowerCase());
                  if (tagName === 'select') {
                    const options = await loc.locator('option').allTextContents();
                    const targetOpt = options.find(o => targetKeywords.some(kw => o.includes(kw)));
                    if (targetOpt) await loc.selectOption({ label: targetOpt });
                  } else {
                    await loc.click({ timeout: 2000 });
                  }
                  targetClicked = true;
                  break;
                } catch { /* ignore */ }
              }
            }
          }

          if (targetClicked) {
            await page.waitForTimeout(2500);
            try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}

            const res = await checkTranslated(1);
            if (res.isTranslated) {
              switched = true;
              switchMethod = `Menu opener: opened via ${behavior.clickedSelector}, selected target language (${res.signals} signals)`;
              finalState = res.newState;
              textChanged = res.textChanged;
              langChanged = res.langChanged;
              dirChanged = res.dirChanged;
            }
          }
        } catch { /* click failed */ }
      }
    }

    // ── Case 3: Fallback — try all locators (original logic) ──
    if (!switched) {
      console.log('[SiteCheck] Q6 — Fallback: trying all language locators');
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

    // ── Check persistence across internal pages ──
    const internalLinks = await discoverInternalLinks(page, page.url(), 2);
    if (internalLinks.length === 0) {
      return makeResult('Q6', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: mainSs.rel,
        notes: `Language switch confirmed (${switchMethod}). No internal links found to verify persistence, but main page switched successfully.`,
      });
    }

    let pagesChecked = 0;
    let pagesWithSwitcher = 0;
    const screenshots: string[] = [mainSs.rel];

    for (let i = 0; i < internalLinks.length; i++) {
      try {
        await navigateAndWait(page, internalLinks[i]);
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

    // Cleanup: navigate back to original URL
    await navigateAndWait(page, url);

    if (pagesChecked === 0) {
      return makeResult('Q6', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: mainSs.rel,
        notes: `Language switch confirmed (${switchMethod}). Could not navigate to internal pages but main page switched successfully.`,
      });
    }

    if (pagesWithSwitcher === pagesChecked) {
      return makeResult('Q6', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: mainSs.rel,
        notes: `Language switch confirmed (${switchMethod}). Translated state persisted across ${pagesChecked} internal pages.`,
      });
    }

    return makeResult('Q6', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: mainSs.rel,
      notes: `Language switch confirmed, but state was lost or switcher missing on ${pagesChecked - pagesWithSwitcher} of ${pagesChecked} internal pages.`,
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
async function checkQ7(page: Page, auditJobId: string): Promise<CriterionResult> {
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

    // Highlight an example image centered in the viewport:
    // one WITH alt text when passing, or one MISSING alt text as failure evidence.
    await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img')).filter(img => {
        const r = img.getBoundingClientRect();
        const s = window.getComputedStyle(img);
        return r.width >= 40 && r.height >= 40 && s.display !== 'none' && s.visibility !== 'hidden';
      });
      const withAlt = imgs.find(i => (i.getAttribute('alt') || '').trim() !== '' || (i.getAttribute('title') || '').trim() !== '');
      const withoutAlt = imgs.find(i => !i.hasAttribute('alt') && (i.getAttribute('title') || '').trim() === '');
      const target = withAlt || withoutAlt;
      if (!target) return;

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
//  Q8 — Text Resizing
//  Detect-and-highlight only (per evaluator decision): locate the text-resize
//  control — or the accessibility (Aa) button that hosts it — highlight it at
//  contextual zoom, and score 1. No clicking or functional testing.
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

async function checkQ8(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const ss = ssPath(auditJobId, '8');

    // 1. A text-size control visible directly on the page
    let controlSel = await findVisibleControl(page, TEXT_RESIZE_SELECTORS, { width: 300, height: 120 });
    let label = 'Text Resize Control';

    // 2. Otherwise the accessibility (Aa) button that hosts the text-size panel
    if (!controlSel) {
      controlSel = await findVisibleControl(page, A11Y_WIDGET_SELECTORS, { width: 300, height: 300 });
      if (controlSel) label = 'Accessibility — Text Size Control';
    }

    if (!controlSel) {
      await viewportShot(page, ss.abs);
      return makeResult('Q8', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: 'No text resizing control (A+/A-, font-size setting, or accessibility menu) found on the page.',
      });
    }

    await takeHighlightedScreenshot(page, ss.abs, [controlSel], {
      contextualZoom: true,
      label,
      maxHighlightBox: { width: 300, height: 300 },
    });

    return makeResult('Q8', {
      scoreEarned: 1,
      status: 'pass',
      screenshotPath: ss.rel,
      notes: 'Text resizing control located and highlighted in the header/accessibility area.',
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
  '[class*="contrast"]', '[id*="contrast"]',
];

async function checkQ10(page: Page, url: string, auditJobId: string): Promise<CriterionResult> {
  try {
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
          await page.locator(widgetSel).first().click({ timeout: 2000 });
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
      await viewportShot(page, ss.abs);
      if (clickedSomething) await navigateAndWait(page, url, { waitAfter: 2000 });
      return makeResult('Q10', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: 'No color contrast / theme adjustment control found on the page.',
      });
    }

    // Screenshot the control at contextual zoom before interacting
    await takeHighlightedScreenshot(page, ss.abs, [controlSel], {
      contextualZoom: true,
      label: 'Contrast Control',
      maxHighlightBox: { width: 300, height: 120 },
    });

    // Functional test: click the control and measure color/theme change
    const before = await sampleTheme();
    let functional = false;
    try {
      await page.locator(controlSel).first().click({ timeout: 2000 });
      clickedSomething = true;
      await page.waitForTimeout(1500);
      const after = await sampleTheme();
      functional =
        before.bodyBg !== after.bodyBg ||
        before.bodyColor !== after.bodyColor ||
        before.htmlFilter !== after.htmlFilter ||
        before.dataTheme !== after.dataTheme;
    } catch { /* control not clickable */ }

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
        notes: 'Color contrast / theme control found and verified functional — clicking it changed the page colors.',
      });
    }
    return makeResult('Q10', {
      scoreEarned: 0.5,
      status: 'partial',
      screenshotPath: ss.rel,
      notes: 'Contrast/theme control is present but clicking it produced no measurable color change (available but not functional).',
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
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId } = params;
  const results: CriterionResult[] = [];

  // Dismiss any cookie banners before starting checks
  await dismissCookieBanner(page);

  // Q4 first — Q5 and Q6 depend on it
  const q4 = await checkQ4(page, auditJobId);
  results.push(q4);

  const q4Passed = q4.status === 'pass';

  // Detect switch behavior (direct toggle vs menu opener) before Q5/Q6
  let behavior: SwitchBehavior = { type: 'unknown', clickedSelector: null };
  if (q4Passed) {
    console.log('[SiteCheck] Q4 passed — detecting language switch behavior...');
    behavior = await detectSwitchBehavior(page, url);
    console.log(`[SiteCheck] Switch behavior detected: ${behavior.type} (selector: ${behavior.clickedSelector})`);
  }

  results.push(await checkQ5(page, url, auditJobId, q4Passed, behavior));
  results.push(await checkQ6(page, url, auditJobId, q4Passed, behavior));
  
  // Independent checks
  results.push(await checkQ7(page, auditJobId));
  results.push(await checkQ8(page, auditJobId));
  results.push(await checkQ9(page, auditJobId));
  results.push(await checkQ10(page, url, auditJobId));

  return results;
}
