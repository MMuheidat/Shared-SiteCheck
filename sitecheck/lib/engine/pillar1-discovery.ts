// lib/engine/pillar1-discovery.ts — Q1, Q1b (Search Presence), Q3 (Google Maps)
//
// Evaluation approach per criterion:
//   Q1:  Search the entity's full official name on a search engine.
//        Pass only if the entity's official website appears on page 1.
//        Screenshot must show: search query, first-page results, official domain.
//   Q1b: Same as Q1 but using the entity acronym.
//   Q3:  Open Google Maps and find the entity's business/place profile.
//        Pass only if the website field matches the official website.
//        Screenshot must show: entity name in Maps AND the website field.
//
// Evidence rules:
//   - CAPTCHA, rewards, sign-in walls, blank pages → retry/switch engine
//   - Screenshot is only saved after the page passes a validation check

import type { Page, Locator } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { takeScreenshot, takeBoxedScreenshot } from '@/lib/engine/helpers';
import { clickWithHighlight, type EvidenceRecorder } from '@/lib/engine/recording';

const PILLAR = 'Discovery & Access';

// ────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────

function makeResult(
  qid: string,
  overrides: Record<string, unknown> = {},
): CriterionResult {
  const def = getCriterion(qid)!;
  return Object.assign(
    {
      qid,
      criterionNameEN: def.nameEN,
      criterionNameAR: def.nameAR,
      pillar: PILLAR,
      subPillar: def.subPillar,
      scoreEarned: 0,
      maxScore: def.maxScore,
      status: 'fail' as const,
      screenshotPath: null as string | null,
      notes: '',
      recommendation: getRecommendation(qid),
    },
    overrides,
  ) as CriterionResult;
}

function ssPath(auditJobId: string, qid: string) {
  return {
    rel: `/screenshots/${auditJobId}/q${qid}.png`,
    abs: path.join(process.cwd(), 'public', 'screenshots', auditJobId, `q${qid}.png`),
  };
}

/** Normalize a URL host for comparison */
function normalizeHost(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Derive an acronym from the entity name (fallback when the evaluator didn't supply one) */
function deriveAcronym(entityName: string): string {
  const trimmed = entityName.trim();

  // 1. Explicit parenthetical acronym: "Abu Dhabi Executive Office (ADEO)"
  const parenthetical = trimmed.match(/\(([A-Z0-9]{2,})\)/)?.[1];
  if (parenthetical) return parenthetical;

  const words = trimmed.split(/\s+/).filter(Boolean);

  // 2. Single-word names ARE the acronym ("TAMM")
  if (words.length === 1) return trimmed;

  // 3. A short all-caps token inside a mixed-case name is the brand acronym:
  //    "TAMM Abu Dhabi Government Services" → "TAMM" (not initials "TADGS").
  //    Skipped when the WHOLE name is uppercase — then caps carry no signal.
  const capsWords = words.filter((w) => /^[A-Z0-9]{2,6}$/.test(w));
  if (capsWords.length > 0 && capsWords.length < words.length) return capsWords[0];

  // 4. Fallback: initials of the significant words
  const cleaned = trimmed
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\b(of|and|the|for|in|on|at|to|a|an)\b/gi, ' ')
    .trim();

  const initials = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('');

  return initials.length >= 2 ? initials.toUpperCase() : trimmed;
}

// ────────────────────────────────────────────────────────────
//  Search evidence validation
//  Checks that the page is a genuine search results page, not
//  a CAPTCHA, Microsoft Rewards, sign-in, or blank page.
// ────────────────────────────────────────────────────────────

interface SearchValidation {
  isValid: boolean;            // Is this a genuine search results page?
  domainFoundOnPage1: boolean; // Is the target domain visible in page-1 results?
  engineUsed: string;          // Which search engine produced valid results
  reason: string;              // Human-readable explanation
}

async function validateSearchPage(
  page: Page,
  targetHost: string | null,
): Promise<SearchValidation> {
  return page.evaluate((host: string | null) => {
    // Hide the recording caption banner while reading page text — its content
    // (entity name / domain) must never influence validation.
    const captionEl = document.getElementById('__sitecheck_caption') as HTMLElement | null;
    const captionDisplay = captionEl ? captionEl.style.display : '';
    if (captionEl) captionEl.style.display = 'none';

    const bodyText = document.body?.innerText?.toLowerCase() || '';
    const html = document.documentElement?.innerHTML?.toLowerCase() || '';
    const title = document.title?.toLowerCase() || '';

    if (captionEl) captionEl.style.display = captionDisplay;

    // ── Blocklist: detect junk pages ──
    const isCaptcha =
      bodyText.includes("i'm not a robot") ||
      bodyText.includes('unusual traffic') ||
      bodyText.includes('captcha') ||
      html.includes('recaptcha');

    const isRewards =
      bodyText.includes('microsoft rewards') ||
      bodyText.includes('earn rewards') ||
      title.includes('rewards');

    const isSignIn =
      (title.includes('sign in') || title.includes('log in')) &&
      !bodyText.includes('search results');

    const isBlank = bodyText.trim().length < 50;

    const isError =
      bodyText.includes('unexpected error') ||
      bodyText.includes('please try again') ||
      bodyText.includes('something went wrong');

    if (isCaptcha) return { isValid: false, domainFoundOnPage1: false, engineUsed: '', reason: 'CAPTCHA detected' };
    if (isRewards) return { isValid: false, domainFoundOnPage1: false, engineUsed: '', reason: 'Microsoft Rewards overlay' };
    if (isSignIn)  return { isValid: false, domainFoundOnPage1: false, engineUsed: '', reason: 'Sign-in wall' };
    if (isBlank)   return { isValid: false, domainFoundOnPage1: false, engineUsed: '', reason: 'Blank/empty page' };
    if (isError)   return { isValid: false, domainFoundOnPage1: false, engineUsed: '', reason: 'Error page' };

    // ── Detect which search engine ──
    let engineUsed = 'unknown';
    if (html.includes('bing.com')) engineUsed = 'Bing';
    else if (html.includes('yahoo.com')) engineUsed = 'Yahoo';
    else if (html.includes('google.com')) engineUsed = 'Google';
    else if (html.includes('duckduckgo')) engineUsed = 'DuckDuckGo';
    else if (html.includes('startpage')) engineUsed = 'Startpage';

    // ── Check for actual search results (links) ──
    const resultLinks = document.querySelectorAll('a[href*="http"]');
    const hasResults = resultLinks.length >= 3; // At least 3 external links

    if (!hasResults) {
      return { isValid: false, domainFoundOnPage1: false, engineUsed, reason: 'No search results found on page' };
    }

    // ── Check if target domain appears on page 1 ──
    let domainFoundOnPage1 = false;
    if (host) {
      // Check all links on the page
      for (const link of resultLinks) {
        const href = (link as HTMLAnchorElement).href?.toLowerCase() || '';
        if (href.includes(host)) {
          domainFoundOnPage1 = true;
          break;
        }
      }
      // Also check visible text
      if (!domainFoundOnPage1 && bodyText.includes(host)) {
        domainFoundOnPage1 = true;
      }
    }

    return { isValid: true, domainFoundOnPage1, engineUsed, reason: 'Valid search results page' };
  }, targetHost);
}

// ────────────────────────────────────────────────────────────
//  Multi-engine search with validation & retry
//  Engines are tried in order (Startpage first, DuckDuckGo as the
//  last resort) and each engine is used the way a person would:
//  open the homepage, type the query, press Enter. The direct
//  ?q= URL is kept as a per-engine fallback when typing fails.
// ────────────────────────────────────────────────────────────

interface SearchEngine {
  name: string;
  homeUrl: string;
  searchBox: string; // query input selector
  results: string;   // selector proving results rendered
  buildUrl: (q: string) => string; // direct-URL fallback
  cleanup?: (page: Page) => Promise<void>; // hide promos/banners before evidence
}

/** Hide DuckDuckGo's right-rail promos ("upgrade to Privacy Pro" etc.) — cosmetics only. */
async function hideDuckDuckGoPromos(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const selectors = [
        '[data-testid="sidebar"]',
        '[data-testid="privacy-reminder"]',
        'section[data-area="sidebar"]',
        '.results--sidebar',
        '.js-sidebar-modules',
        'aside',
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          (el as HTMLElement).style.display = 'none';
        });
      }
    });
  } catch { /* best effort */ }
}

const SEARCH_ENGINES: SearchEngine[] = [
  {
    name: 'Startpage',
    homeUrl: 'https://www.startpage.com',
    searchBox: 'input#q, input[name="query"]',
    results: '[class*="result"] a[href*="http"], .w-gl__result',
    buildUrl: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`,
  },
  {
    name: 'Yahoo',
    homeUrl: 'https://search.yahoo.com',
    searchBox: 'input[name="p"]',
    results: '#results, #web ol, .algo',
    buildUrl: (q) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`,
  },
  {
    name: 'Bing',
    homeUrl: 'https://www.bing.com',
    searchBox: '#sb_form_q, input[name="q"]',
    results: '#b_results .b_algo',
    buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: 'Google',
    homeUrl: 'https://www.google.com',
    searchBox: 'textarea[name="q"], input[name="q"]',
    results: '#search a[href*="http"], #rso',
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: 'DuckDuckGo',
    homeUrl: 'https://duckduckgo.com',
    searchBox: '#searchbox_input, input[name="q"]',
    results: '[data-testid="result"], article[data-nrn], #links',
    buildUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    cleanup: hideDuckDuckGoPromos,
  },
];

/**
 * Quick consent-dialog dismissal for search engine pages (Google/Yahoo/Startpage
 * show these in some regions). One combined locator with a short timeout —
 * helpers.dismissCookieBanner is too slow here (~0.5s per selector × 26).
 */
async function dismissSearchConsent(page: Page): Promise<void> {
  try {
    const btn = page
      .locator(
        'button:has-text("Accept all"), button:has-text("Accept All"), button:has-text("I agree"), ' +
        'button:has-text("Agree"), form[action*="consent"] button, button#L2AGLb',
      )
      .first();
    if (await btn.isVisible({ timeout: 700 })) {
      await btn.click({ timeout: 2000 });
      await page.waitForTimeout(400);
    }
  } catch { /* no consent dialog */ }
}

/**
 * Tag the first visible result anchor matching the audited host with
 * data-sitecheck-target="1" (and force target=_self so the click stays in the
 * recorded page). Handles redirect-wrapped hrefs (Bing/Yahoo/Google) via
 * decodeURIComponent and visible-text matching.
 */
async function tagFirstMatchingResult(page: Page, host: string): Promise<boolean> {
  try {
    return await page.evaluate((h: string) => {
      document
        .querySelectorAll('a[data-sitecheck-target]')
        .forEach((a) => a.removeAttribute('data-sitecheck-target'));

      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
      const isMatch = (a: HTMLAnchorElement) => {
        const href = (a.href || '').toLowerCase();
        let decoded = href;
        try { decoded = decodeURIComponent(href); } catch { /* keep raw */ }
        const text = (a.textContent || '').toLowerCase();
        if (!href.includes(h) && !decoded.includes(h) && !text.includes(h)) return false;
        const rect = a.getBoundingClientRect();
        return rect.width >= 5 && rect.height >= 5; // skip hidden/collapsed anchors
      };
      // Prefer the result's title link — the largest text-bearing match — over
      // favicon/breadcrumb anchors that share the same href.
      const matches = anchors.filter(isMatch);
      const textMatches = matches.filter((a) => (a.textContent || '').trim().length >= 4);
      const area = (a: HTMLAnchorElement) => {
        const r = a.getBoundingClientRect();
        return r.width * r.height;
      };
      const pool = textMatches.length > 0 ? textMatches : matches;
      const candidate = pool.sort((a, b) => area(b) - area(a))[0];
      if (!candidate) return false;
      candidate.setAttribute('data-sitecheck-target', '1');
      candidate.setAttribute('target', '_self');
      return true;
    }, host);
  } catch {
    return false;
  }
}

const TAGGED_RESULT = 'a[data-sitecheck-target="1"]';

/** Scroll the tagged result into view with visible wheel steps (for the recording). */
async function scrollResultIntoView(page: Page, locator: Locator): Promise<void> {
  try {
    for (let i = 0; i < 14; i++) {
      const box = await locator.boundingBox().catch(() => null);
      const vp = page.viewportSize();
      if (box && vp && box.y >= 0 && box.y + box.height <= vp.height) return;
      await page.mouse.wheel(0, 420);
      await page.waitForTimeout(120);
    }
    await locator.scrollIntoViewIfNeeded();
  } catch { /* cosmetics only */ }
}

/**
 * ~1s of human-like scanning: a few visible wheel steps down the results, then
 * back to the top. Pure video cosmetics — never affects verdicts.
 */
async function humanScanScroll(page: Page): Promise<void> {
  try {
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(180);
    }
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(250);
  } catch { /* cosmetics only */ }
}

/**
 * Click the tagged result, wait until the page lands on the audited host, then
 * scan-scroll the landed site (~1s) as a human "this is the right site" check.
 * Pure evidence choreography — failures never affect the criterion outcome.
 */
async function visitTaggedResult(page: Page, host: string): Promise<boolean> {
  try {
    const target = page.locator(TAGGED_RESULT).first();
    if ((await target.count()) === 0) return false;
    await scrollResultIntoView(page, target);
    await clickWithHighlight(target, { timeout: 6000, holdMs: 400 });
    await page.waitForURL(
      (u) => {
        const uh = u.hostname.replace(/^www\./i, '').toLowerCase();
        return uh === host || uh.endsWith(`.${host}`);
      },
      { timeout: 12000, waitUntil: 'domcontentloaded' },
    );
    await page.waitForTimeout(500);
    await humanScanScroll(page);
    return true;
  } catch {
    return false;
  }
}

async function performSearchWithEvidence(
  page: Page,
  query: string,
  targetHost: string | null,
  screenshotAbsPath: string,
  recorder?: EvidenceRecorder,
  qLabel?: string,
  options?: { deferScreenshot?: boolean }, // caller takes the success screenshot itself
): Promise<SearchValidation & { screenshotTaken: boolean }> {
  for (const engine of SEARCH_ENGINES) {
    console.log(`[SiteCheck] Trying ${engine.name} for query: "${query}"...`);
    await recorder?.setCaption(`${qLabel ?? 'Search'} — Searching "${query}" on ${engine.name}…`);

    // Attempt 1: human-like — homepage, type the query, Enter.
    // Attempt 2 (same engine): direct results URL.
    for (const mode of ['type', 'direct'] as const) {
      try {
        if (mode === 'type') {
          await page.goto(engine.homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await dismissSearchConsent(page);
          const box = page.locator(engine.searchBox).first();
          await box.waitFor({ state: 'visible', timeout: 5000 });
          await box.click({ timeout: 3000 });
          await box.pressSequentially(query, { delay: 15 });
          await page.keyboard.press('Enter');
        } else {
          await page.goto(engine.buildUrl(query), { waitUntil: 'domcontentloaded', timeout: 15000 });
        }

        await page.waitForSelector(engine.results, { timeout: 7000 }).catch(() => {});
        await page.waitForTimeout(300);
        await engine.cleanup?.(page);

        const validation = await validateSearchPage(page, targetHost);

        if (validation.isValid) {
          console.log(
            `[SiteCheck] ✅ ${engine.name} (${mode}) returned valid results. Domain found: ${validation.domainFoundOnPage1}`,
          );
          await recorder?.setCaption(
            validation.domainFoundOnPage1
              ? `${qLabel ?? 'Search'} — ✓ Official website found on page 1 of ${engine.name} results`
              : `${qLabel ?? 'Search'} — ✗ Official website NOT found on page 1 of ${engine.name} results`,
          );

          if (targetHost && validation.domainFoundOnPage1) {
            await tagFirstMatchingResult(page, targetHost);
          }

          if (!options?.deferScreenshot) {
            await takeScreenshot(page, screenshotAbsPath, { waitMs: 400 });
          }

          return {
            ...validation,
            engineUsed: engine.name,
            screenshotTaken: !options?.deferScreenshot,
          };
        }

        console.log(
          `[SiteCheck] ❌ ${engine.name} (${mode}) failed validation: ${validation.reason}.`,
        );
        break; // invalid results page (captcha/blank) — direct URL won't do better, next engine
      } catch (err) {
        console.log(
          `[SiteCheck] ❌ ${engine.name} (${mode}) threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        // typing flow broke → retry same engine via direct URL; direct also broke → next engine
      }
    }
  }

  // All engines failed — take screenshot of whatever is on screen as fallback evidence
  console.log('[SiteCheck] All search engines failed. Taking fallback screenshot.');
  await recorder?.setCaption(`${qLabel ?? 'Search'} — ✗ All search engines blocked or returned errors`);
  try {
    await takeScreenshot(page, screenshotAbsPath);
  } catch { /* */ }

  return {
    isValid: false,
    domainFoundOnPage1: false,
    engineUsed: 'none',
    reason: 'All search engines blocked or returned errors',
    screenshotTaken: true,
  };
}

// ────────────────────────────────────────────────────────────
//  Q1 — Search Presence (entity full name)
//  Search the entity's full official name on a search engine.
//  Pass only if the entity's official website appears on page 1.
// ────────────────────────────────────────────────────────────
async function checkQ1(
  page: Page,
  url: string,
  auditJobId: string,
  entityName: string,
  recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  const ss = ssPath(auditJobId, '1');
  const auditedHost = normalizeHost(url);
  const stamp = recorder ? ` [${recorder.stamp()}]` : '';

  try {
    console.log(`[SiteCheck] Q1 — Searching for entity full name: "${entityName}"`);

    // Search; the screenshot is deferred so the entity's result can be scanned,
    // highlighted, and only then captured — like a person finding the link.
    const result = await performSearchWithEvidence(page, entityName, auditedHost, ss.abs, recorder, 'Q1', {
      deferScreenshot: true,
    });

    // Evidence choreography: scan, highlight, screenshot, then open the result
    // and land on the entity site. The pass/fail verdict is already decided —
    // a failed click never changes it.
    if (result.isValid && !result.screenshotTaken) {
      if (result.domainFoundOnPage1 && auditedHost) {
        const target = page.locator(TAGGED_RESULT).first();
        await scrollResultIntoView(page, target);
        await takeBoxedScreenshot(page, ss.abs, [TAGGED_RESULT], {
          label: `Official website (${auditedHost})`,
          containerize: true,
          waitMs: 400,
        });
        await recorder?.setCaption(`Q1 — Opening the official website from the ${result.engineUsed} results…`);
        await visitTaggedResult(page, auditedHost);
      } else {
        await takeScreenshot(page, ss.abs, { waitMs: 400 });
      }
    }

    if (result.isValid && result.domainFoundOnPage1) {
      // PASS — entity found on page 1 of a real search results page
      return makeResult('Q1', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: ss.rel,
        notes:
          `Searched "${entityName}" on ${result.engineUsed}. ` +
          `The entity's official website (${auditedHost}) appears on the first page of search results.${stamp}`,
        recommendation: '',
      });
    } else if (result.isValid && !result.domainFoundOnPage1) {
      // FAIL — valid search page but domain not found on page 1
      return makeResult('Q1', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes:
          `Searched "${entityName}" on ${result.engineUsed}. ` +
          `The entity's official website (${auditedHost}) was NOT found on the first page of search results.${stamp}`,
      });
    } else {
      // All engines blocked — check if site is live as indirect evidence
      // A live government site with proper SEO should appear on Google page 1,
      // but we can't prove it because all engines blocked us
      return makeResult('Q1', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes:
          `Could not verify search presence: ${result.reason}. ` +
          `All search engines blocked the automated browser. ` +
          `Manual verification is required for this criterion.${stamp}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SiteCheck] Q1 — Error:`, msg);
    try { await takeScreenshot(page, ss.abs); } catch { /* */ }

    return makeResult('Q1', {
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Error checking Q1: ${msg}`,
    });
  }
}

// ────────────────────────────────────────────────────────────
//  Q1b — Search Presence (entity acronym, non-scored)
//  Same approach as Q1 but using the entity's acronym.
// ────────────────────────────────────────────────────────────
async function checkQ1b(
  page: Page,
  url: string,
  auditJobId: string,
  entityName: string,
  suppliedAcronym: string,
  recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  const ss = ssPath(auditJobId, '1b');
  const acronym = suppliedAcronym.trim() || deriveAcronym(entityName);
  const auditedHost = normalizeHost(url);
  const stamp = recorder ? ` [${recorder.stamp()}]` : '';

  try {
    console.log(`[SiteCheck] Q1b — Searching for entity acronym: "${acronym}"`);

    // Search; the screenshot is deferred so the found result can be scrolled
    // into view and highlighted first. Acronyms are often ambiguous (other
    // companies may rank above the entity) — the entity passes if its site
    // appears ANYWHERE on page 1, not only at the top.
    const result = await performSearchWithEvidence(page, acronym, auditedHost, ss.abs, recorder, 'Q1b', {
      deferScreenshot: true,
    });

    if (result.isValid && !result.screenshotTaken) {
      if (result.domainFoundOnPage1 && auditedHost) {
        // Scroll down the results until the entity's link is in view, box it
        // for the screenshot, then open it on video.
        const target = page.locator(TAGGED_RESULT).first();
        await scrollResultIntoView(page, target);
        await takeBoxedScreenshot(page, ss.abs, [TAGGED_RESULT], {
          label: `Official website (${auditedHost})`,
          containerize: true,
          waitMs: 400,
        });
        await recorder?.setCaption(`Q1b — Opening the official website from the ${result.engineUsed} results…`);
        await visitTaggedResult(page, auditedHost);
      } else {
        await takeScreenshot(page, ss.abs, { waitMs: 400 });
      }
    }

    if (result.isValid && result.domainFoundOnPage1) {
      return makeResult('Q1b', {
        scoreEarned: 0, // Q1b is non-scored
        status: 'pass',
        screenshotPath: ss.rel,
        notes:
          `Searched acronym "${acronym}" on ${result.engineUsed}. ` +
          `The entity's official website (${auditedHost}) appears on the first page of search results.${stamp}`,
        recommendation: '',
      });
    } else if (result.isValid) {
      return makeResult('Q1b', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes:
          `Searched acronym "${acronym}" on ${result.engineUsed}. ` +
          `The entity's official website was NOT found on the first page of search results.${stamp}`,
      });
    } else {
      return makeResult('Q1b', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes:
          `Could not verify search presence for acronym "${acronym}": ${result.reason}. ` +
          `Manual verification is required.${stamp}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { await takeScreenshot(page, ss.abs); } catch { /* */ }

    return makeResult('Q1b', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Error checking Q1b: ${msg}`,
    });
  }
}

// ────────────────────────────────────────────────────────────
//  Q3 — Google Maps website check
//  Open the entity's actual Google Maps business/place profile.
//  Pass only if the website field matches the official website.
//  Screenshot must show entity name AND the website field.
//
//  HARD FAIL: Any screenshot showing a generic geographic page
//  (emirate, city, region — e.g. "Abu Dhabi", "Dubai") is
//  rejected even if internal logic found the domain in HTML.
// ────────────────────────────────────────────────────────────

interface MapsValidation {
  isBusinessProfile: boolean;  // Are we on a real place profile (not a city page)?
  isGenericGeoPage: boolean;   // HARD FAIL: Is this a city/emirate/region page?
  entityNameVisible: boolean;  // Is the entity name visible?
  websiteField: string | null; // The website URL shown on the Maps profile
  websiteMatches: boolean;     // Does the website field match the audited URL?
  pageTitle: string;           // The visible title/heading on the Maps panel
}

// Known UAE geographic names — if the Maps panel heading matches
// one of these, it's a generic geo page, NOT a business profile.
const GEO_NAMES = [
  'abu dhabi', 'أبو ظبي', 'ابوظبي', 'أبوظبي',
  'dubai', 'دبي',
  'sharjah', 'الشارقة',
  'ajman', 'عجمان',
  'ras al khaimah', 'رأس الخيمة',
  'umm al quwain', 'أم القيوين',
  'fujairah', 'الفجيرة',
  'al ain', 'العين',
  'united arab emirates', 'الإمارات العربية المتحدة', 'الامارات',
];

async function validateMapsPage(
  page: Page,
  entityName: string,
  targetHost: string | null,
): Promise<MapsValidation> {
  return page.evaluate(
    (args: { entity: string; host: string | null; geoNames: string[] }) => {
      // Hide the recording caption banner while reading page text — its content
      // (entity name / website field) must never influence validation.
      const captionEl = document.getElementById('__sitecheck_caption') as HTMLElement | null;
      const captionDisplay = captionEl ? captionEl.style.display : '';
      if (captionEl) captionEl.style.display = 'none';

      const bodyText = document.body?.innerText || '';

      if (captionEl) captionEl.style.display = captionDisplay;

      const bodyLower = bodyText.toLowerCase();
      const entityLower = args.entity.toLowerCase();

      // ── Detect the visible panel heading/title ──
      // Google Maps shows the place name in an h1 or a prominent heading element
      let pageTitle = '';
      const headingSelectors = [
        'h1.fontHeadlineLarge',   // Modern Maps
        'h1.section-hero-header-title-title', // Older Maps
        'h1',                     // Generic fallback
        'span.fontHeadlineLarge',
        '[data-attrid="title"]',
      ];
      // Labels the results panel uses in EN/AR — never a place name
      const nonTitles = ['results', 'النتائج', 'نتائج'];
      for (const sel of headingSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent?.trim() || '';
          if (t && !nonTitles.includes(t.toLowerCase())) {
            pageTitle = t;
            break;
          }
        }
        if (pageTitle) break;
      }
      const pageTitleLower = pageTitle.toLowerCase().trim();

      // ── HARD FAIL: Detect generic geographic pages ──
      let isGenericGeoPage = false;
      for (const geo of args.geoNames) {
        // The panel title IS the geo name (exact or near-exact)
        if (pageTitleLower === geo || pageTitleLower === geo.replace(/ /g, '')) {
          isGenericGeoPage = true;
          break;
        }
      }
      // Also flag if the title is purely a location with no org keywords
      if (
        !isGenericGeoPage &&
        pageTitle.length > 0 &&
        !bodyLower.includes('website') &&
        !bodyLower.includes('موقع') &&
        !bodyLower.includes('phone') &&
        !bodyLower.includes('هاتف') &&
        // Generic geo pages show "Quick facts" / "حقائق سريعة"
        (bodyLower.includes('quick facts') || bodyLower.includes('حقائق سريعة'))
      ) {
        isGenericGeoPage = true;
      }

      // ── Check if entity name (or key words) is visible ──
      const entityWords = entityLower.split(/\s+/).filter((w) => w.length > 2);
      const matchingWords = entityWords.filter((w) => bodyLower.includes(w));
      const entityNameVisible = matchingWords.length >= Math.ceil(entityWords.length / 2);

      // ── Business profile detection ──
      // A business profile has: website, phone, directions, reviews, hours
      // A city/region page has: "Quick facts", images, but NO website/phone
      const hasWebsiteElement =
        document.querySelector('a[data-item-id="authority"]') !== null ||
        document.querySelector('[data-tooltip="Open website"]') !== null ||
        document.querySelector('.LrzXr') !== null;

      const hasPhoneElement =
        document.querySelector('[data-item-id^="phone:"]') !== null ||
        bodyLower.includes('phone') ||
        bodyLower.includes('هاتف');

      const hasDirectionsButton =
        document.querySelector('button[data-value="Directions"]') !== null ||
        document.querySelector('a[href*="dir/"]') !== null;

      const hasBusinessInfo = hasWebsiteElement || (hasPhoneElement && hasDirectionsButton);

      // ── Extract the website field ──
      let websiteField: string | null = null;

      // Method 1: Authority link
      const authorityLink = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement;
      if (authorityLink) {
        websiteField = authorityLink.href || authorityLink.textContent?.trim() || null;
      }

      // Method 2: Website tooltip button
      if (!websiteField) {
        const websiteBtn = document.querySelector('[data-tooltip="Open website"]') as HTMLAnchorElement;
        if (websiteBtn) {
          websiteField = websiteBtn.getAttribute('href') || null;
        }
      }

      // Method 3: LrzXr class (Maps website link)
      if (!websiteField) {
        const lrzEl = document.querySelector('.LrzXr') as HTMLAnchorElement;
        if (lrzEl) {
          websiteField = lrzEl.closest('a')?.href || lrzEl.textContent?.trim() || null;
        }
      }

      // Method 4: Visible text near "website" / "موقع"
      if (!websiteField) {
        const lines = bodyText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].toLowerCase();
          if (line.includes('website') || line.includes('موقع إلكتروني') || line.includes('موقع')) {
            const urlMatch = (lines[i] + ' ' + (lines[i + 1] || '')).match(
              /https?:\/\/[^\s]+|www\.[^\s]+/i
            );
            if (urlMatch) {
              websiteField = urlMatch[0];
              break;
            }
          }
        }
      }

      // ── Check domain match ──
      let websiteMatches = false;
      if (websiteField && args.host) {
        try {
          const fieldHost = new URL(
            websiteField.startsWith('http') ? websiteField : `https://${websiteField}`
          ).hostname.replace(/^www\./i, '').toLowerCase();
          websiteMatches = fieldHost === args.host;
        } catch {
          websiteMatches = websiteField.toLowerCase().includes(args.host);
        }
      }

      const isBusinessProfile = hasBusinessInfo && !isGenericGeoPage;

      return {
        isBusinessProfile,
        isGenericGeoPage,
        entityNameVisible,
        websiteField: isGenericGeoPage ? null : websiteField, // Discard website from geo pages
        websiteMatches: isGenericGeoPage ? false : websiteMatches,
        pageTitle,
      };
    },
    { entity: entityName, host: targetHost, geoNames: GEO_NAMES },
  );
}

// Where the website URL appears on a Maps place panel (highlight/click targets)
const MAPS_WEBSITE_SELECTORS = [
  'a[data-item-id="authority"]',
  '[data-tooltip="Open website"]',
  '.LrzXr',
];

/**
 * One Google Maps search pass: open Maps, type the query like a person would
 * (direct /maps/search URL as fallback), open the best-matching result, and
 * validate the resulting panel. Validation always runs against `entityName`,
 * even when `query` is a refined variant.
 */
async function searchMapsAndOpenProfile(
  page: Page,
  query: string,
  entityName: string,
  auditedHost: string | null,
): Promise<MapsValidation> {
  // Human-like flow: Maps home → type → Enter
  try {
    if (!page.url().startsWith('https://www.google.com/maps')) {
      await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    await dismissSearchConsent(page);
    const box = page.locator('input#searchboxinput').first();
    await box.waitFor({ state: 'visible', timeout: 6000 });
    await box.click({ timeout: 3000 });
    await box.evaluate((el: Element) => { (el as HTMLInputElement).value = ''; });
    await box.pressSequentially(query, { delay: 25 });
    await page.keyboard.press('Enter');
  } catch {
    // Fallback: direct search URL
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { /* */ });
    await dismissSearchConsent(page);
  }

  // Wait for either a results feed or a place panel (selectors cover the
  // localized/Arabic Maps UI variants too)
  await page
    .waitForSelector(
      'div[role="feed"], a.hfpxzc, div.Nv2PK, a[data-item-id="authority"], h1.fontHeadlineLarge',
      { timeout: 7000 },
    )
    .catch(() => { /* */ });
  await page.waitForTimeout(800);

  // If a results list is showing, open the FIRST result. Label-based matching
  // is unreliable here: Maps often localizes result labels into Arabic while
  // the entity name is Latin (e.g. "مركز خدمة متعاملين تم" for TAMM), so word
  // scoring skips the genuine top result. A wrong first pick is still caught by
  // validateMapsPage (website-host check) and the fallback re-search in checkQ3.
  try {
    const feedResults = page.locator('div[role="feed"] a.hfpxzc, a.hfpxzc, a[href*="/maps/place/"]');
    const count = await feedResults.count();
    if (count > 0) {
      await clickWithHighlight(feedResults.first(), { timeout: 5000, holdMs: 400 });
      await page
        .waitForSelector('a[data-item-id="authority"], h1.fontHeadlineLarge, h1', { timeout: 7000 })
        .catch(() => { /* */ });
      await page.waitForTimeout(500);
    }
  } catch { /* already on a place panel */ }

  return validateMapsPage(page, entityName, auditedHost);
}

async function checkQ3(
  page: Page,
  url: string,
  auditJobId: string,
  entityName: string,
  suppliedAcronym: string,
  recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  const ss = ssPath(auditJobId, '3');
  const auditedHost = normalizeHost(url);
  const stamp = recorder ? ` [${recorder.stamp()}]` : '';

  try {
    // Keyword-first: a bare entity name containing a geo token ("… Abu Dhabi …")
    // makes Maps resolve the CITY page, wasting a visible search. The qualified
    // query goes first; the short brand name (acronym) is the one fallback.
    const primaryQuery = `${entityName} website`;
    const effectiveAcronym = suppliedAcronym.trim() || deriveAcronym(entityName);
    const fallbackQuery =
      effectiveAcronym.toLowerCase() !== entityName.trim().toLowerCase()
        ? effectiveAcronym
        : `${entityName} office`;

    console.log(`[SiteCheck] Q3 — Searching Google Maps for: "${primaryQuery}"`);
    await recorder?.setCaption(`Q3 — Google Maps: locating the business profile for "${entityName}"…`);

    let validation = await searchMapsAndOpenProfile(page, primaryQuery, entityName, auditedHost);

    // One short fallback when the first search resolved to a generic
    // geographic page or no recognizable profile.
    if (validation.isGenericGeoPage || !validation.isBusinessProfile) {
      console.log(
        `[SiteCheck] Q3 — First Maps search inconclusive ("${validation.pageTitle}"), retrying with "${fallbackQuery}"…`,
      );
      await recorder?.setCaption(`Q3 — Refining the Google Maps search…`);
      const recheck = await searchMapsAndOpenProfile(page, fallbackQuery, entityName, auditedHost);
      if (!recheck.isGenericGeoPage && recheck.isBusinessProfile) {
        validation = recheck;
      }
    }

    console.log(
      `[SiteCheck] Q3 — Maps validation: ` +
        `title="${validation.pageTitle}", profile=${validation.isBusinessProfile}, ` +
        `geoPage=${validation.isGenericGeoPage}, website="${validation.websiteField}", ` +
        `matches=${validation.websiteMatches}`,
    );

    // Geo page → HARD FAIL, plain screenshot as evidence
    if (validation.isGenericGeoPage) {
      await recorder?.setCaption(
        `Q3 — ✗ Only a generic location page ("${validation.pageTitle}") was found — no business profile`,
      );
      await takeScreenshot(page, ss.abs, { waitMs: 400 });

      return makeResult('Q3', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes:
          `HARD FAIL: Google Maps search for "${entityName}" landed on a generic geographic page ` +
          `("${validation.pageTitle}") instead of the entity's business/place profile. ` +
          `The screenshot does not show the official entity listing. ` +
          `No website evidence is valid from a city/emirate page.${stamp}`,
      });
    }

    // Evidence screenshot — with the website field highlighted (the criterion
    // is about the website shown on Maps matching the entity's site).
    await recorder?.setCaption(
      validation.isBusinessProfile && validation.websiteMatches
        ? `Q3 — ✓ Maps profile "${validation.pageTitle}" lists the official website`
        : validation.isBusinessProfile && validation.websiteField
        ? `Q3 — ✗ Maps profile "${validation.pageTitle}" lists a DIFFERENT website`
        : validation.isBusinessProfile
        ? `Q3 — ✗ Maps profile "${validation.pageTitle}" has no website listed`
        : `Q3 — ✗ No recognizable business profile found on Google Maps`,
    );
    if (validation.websiteField) {
      // Minimal framing: one wheel step over the place panel so the website row
      // sits above the bottom edge (Maps panels scroll independently — the wheel
      // must happen with the mouse over the panel, not the map). Cosmetics only.
      try {
        const panelAnchor = page
          .locator(`${MAPS_WEBSITE_SELECTORS.join(', ')}, h1.fontHeadlineLarge`)
          .first();
        const box = await panelAnchor.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, 200);
          await page.waitForTimeout(300);
        }
      } catch { /* cosmetics only */ }

      await takeBoxedScreenshot(page, ss.abs, MAPS_WEBSITE_SELECTORS, {
        label: `Website on Google Maps`,
        padding: 6,
        waitMs: 400,
      });
    } else {
      await takeScreenshot(page, ss.abs, { waitMs: 400 });
    }

    // Choreography: when the website matches, click it and land on the entity
    // site so the recording shows the full journey. Maps opens websites in a
    // new tab, which would not appear in the recorded page's video — force
    // same-tab navigation first. Failures here never change the verdict.
    if (validation.isBusinessProfile && validation.websiteMatches && auditedHost) {
      try {
        await recorder?.setCaption(`Q3 — Opening the website listed on Google Maps…`);
        const websiteLink = page.locator(MAPS_WEBSITE_SELECTORS.join(', ')).first();
        if (await websiteLink.isVisible({ timeout: 2000 })) {
          await websiteLink.evaluate((el: Element) => {
            const a = el.closest('a') ?? el;
            (a as HTMLAnchorElement).setAttribute('target', '_self');
          });
          await clickWithHighlight(websiteLink, { timeout: 6000, holdMs: 400 });
          await page
            .waitForURL(
              (u) => {
                const uh = u.hostname.replace(/^www\./i, '').toLowerCase();
                return uh === auditedHost || uh.endsWith(`.${auditedHost}`);
              },
              { timeout: 12000, waitUntil: 'domcontentloaded' },
            )
            .catch(() => {});
          await page.waitForTimeout(500);
          await humanScanScroll(page); // verify gesture on the landed entity site
        }
      } catch { /* evidence choreography only */ }
    }

    // Determine result
    if (validation.isBusinessProfile && validation.websiteMatches) {
      // PASS — website field matches the official website
      return makeResult('Q3', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes:
          `Entity "${entityName}" found on Google Maps (profile: "${validation.pageTitle}"). ` +
          `The website field ("${validation.websiteField}") matches the official website (${auditedHost}).${stamp}`,
        recommendation: '',
      });
    } else if (validation.isBusinessProfile && validation.websiteField) {
      // FAIL — website field exists but shows a different URL
      return makeResult('Q3', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes:
          `Entity "${entityName}" found on Google Maps (profile: "${validation.pageTitle}"). ` +
          `Incorrect website URL: the Maps listing shows "${validation.websiteField}" ` +
          `instead of the official website (${auditedHost}).${stamp}`,
      });
    } else if (validation.isBusinessProfile && !validation.websiteField) {
      // FAIL — business profile exists but no website field
      return makeResult('Q3', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes:
          `Entity "${entityName}" found on Google Maps (profile: "${validation.pageTitle}"), ` +
          `but no website is listed on the profile. ` +
          `No - Website is not mentioned on Google Maps.${stamp}`,
      });
    } else {
      // FAIL — entity not found or not on a proper business profile
      return makeResult('Q3', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes:
          `Google Maps search for "${entityName}" did not resolve to a recognizable business/place profile. ` +
          `Page title: "${validation.pageTitle}". No website field was found.${stamp}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SiteCheck] Q3 — Error:`, msg);

    try {
      await takeScreenshot(page, ss.abs);
    } catch {
      /* */
    }

    return makeResult('Q3', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Error checking Google Maps for "${entityName}": ${msg}`,
    });
  }
}

export default async function pillar1Discovery(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  acronym?: string;
  previousResults: CriterionResult[];
  recorder?: EvidenceRecorder;
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, entityName, acronym, recorder } = params;
  const results: CriterionResult[] = [];

  await recorder?.setCaption(`Pillar 1 — Discovery & Access: automated check for "${entityName}"`);

  // Q1a is manual-only (entity category selection), skip it
  results.push(makeResult('Q1a', {
    status: 'na',
    notes: 'Manual criterion — entity category selection done by evaluator.',
    recommendation: '',
  }));

  results.push(await checkQ1(page, url, auditJobId, entityName, recorder));
  results.push(await checkQ1b(page, url, auditJobId, entityName, acronym ?? '', recorder));
  results.push(await checkQ3(page, url, auditJobId, entityName, acronym ?? '', recorder));

  await recorder?.setCaption('Pillar 1 — Discovery & Access: checks complete');
  return results;
}
