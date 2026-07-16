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

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { takeScreenshot } from '@/lib/engine/helpers';
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

/** Derive an acronym from the entity name */
function deriveAcronym(entityName: string): string {
  const parenthetical = entityName.match(/\(([A-Z0-9]{2,})\)/)?.[1];
  if (parenthetical) return parenthetical;

  const cleaned = entityName
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\b(of|and|the|for|in|on|at|to|a|an)\b/gi, ' ')
    .trim();

  const initials = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('');

  return initials.length >= 2 ? initials.toUpperCase() : entityName.trim();
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
//  Tries multiple search engines until one gives valid results.
//  Returns the validation result from the first successful engine.
// ────────────────────────────────────────────────────────────

const SEARCH_ENGINES = [
  { name: 'DuckDuckGo', buildUrl: (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  { name: 'Startpage',  buildUrl: (q: string) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}` },
  { name: 'Yahoo',      buildUrl: (q: string) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}` },
  { name: 'Bing',       buildUrl: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { name: 'Google',     buildUrl: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
];

async function performSearchWithEvidence(
  page: Page,
  query: string,
  targetHost: string | null,
  screenshotAbsPath: string,
  recorder?: EvidenceRecorder,
  qLabel?: string,
): Promise<SearchValidation & { screenshotTaken: boolean }> {
  for (const engine of SEARCH_ENGINES) {
    console.log(`[SiteCheck] Trying ${engine.name} for query: "${query}"...`);
    await recorder?.setCaption(`${qLabel ?? 'Search'} — Searching "${query}" on ${engine.name}…`);

    try {
      const searchUrl = engine.buildUrl(query);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(4000); // Let results render

      // Validate the page
      const validation = await validateSearchPage(page, targetHost);

      if (validation.isValid) {
        console.log(`[SiteCheck] ✅ ${engine.name} returned valid results. Domain found: ${validation.domainFoundOnPage1}`);
        await recorder?.setCaption(
          validation.domainFoundOnPage1
            ? `${qLabel ?? 'Search'} — ✓ Official website found on page 1 of ${engine.name} results`
            : `${qLabel ?? 'Search'} — ✗ Official website NOT found on page 1 of ${engine.name} results`,
        );

        // Take screenshot — page is validated
        await takeScreenshot(page, screenshotAbsPath);

        return {
          ...validation,
          engineUsed: engine.name,
          screenshotTaken: true,
        };
      } else {
        console.log(`[SiteCheck] ❌ ${engine.name} failed validation: ${validation.reason}. Trying next engine...`);
      }
    } catch (err) {
      console.log(`[SiteCheck] ❌ ${engine.name} threw an error: ${err instanceof Error ? err.message : String(err)}`);
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

    // Perform search with validation and retry across engines
    const result = await performSearchWithEvidence(page, entityName, auditedHost, ss.abs, recorder, 'Q1');

    // Navigate back to audited site for subsequent checks
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(3000);
    } catch { /* best effort */ }

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
  recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  const ss = ssPath(auditJobId, '1b');
  const acronym = deriveAcronym(entityName);
  const auditedHost = normalizeHost(url);
  const stamp = recorder ? ` [${recorder.stamp()}]` : '';

  try {
    console.log(`[SiteCheck] Q1b — Searching for entity acronym: "${acronym}"`);

    // Perform search with validation and retry across engines
    const result = await performSearchWithEvidence(page, acronym, auditedHost, ss.abs, recorder, 'Q1b');

    // Navigate back
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(3000);
    } catch { /* best effort */ }

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
      for (const sel of headingSelectors) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim()) {
          pageTitle = el.textContent.trim();
          break;
        }
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

async function checkQ3(
  page: Page,
  url: string,
  auditJobId: string,
  entityName: string,
  recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  const ss = ssPath(auditJobId, '3');
  const auditedHost = normalizeHost(url);
  const stamp = recorder ? ` [${recorder.stamp()}]` : '';

  try {
    // Step 1: Navigate to Google Maps search for the entity
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(entityName)}`;
    console.log(`[SiteCheck] Q3 — Navigating to Google Maps for: "${entityName}"`);
    await recorder?.setCaption(`Q3 — Google Maps: locating the business profile for "${entityName}"…`);

    await page.goto(mapsUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(async () => {
      await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    });
    await page.waitForTimeout(5000);

    // Handle consent popup
    try {
      const consentButton = page
        .locator(
          'button:has-text("Accept all"), button:has-text("Accept"), button:has-text("I agree"), form[action*="consent"] button',
        )
        .first();
      if (await consentButton.isVisible({ timeout: 2000 })) {
        await clickWithHighlight(consentButton);
        await page.waitForTimeout(3000);
      }
    } catch {
      /* no consent popup */
    }

    // Step 2: Try clicking on the first search result to open the business profile
    try {
      const firstResult = page.locator('a[href*="/maps/place/"], div.Nv2PK a, a.hfpxzc').first();
      if (await firstResult.isVisible({ timeout: 3000 })) {
        await recorder?.setCaption(`Q3 — Opening the first Google Maps result for "${entityName}"…`);
        await clickWithHighlight(firstResult);
        await page.waitForTimeout(5000);
      }
    } catch {
      /* might already be on the detail view */
    }

    // Step 3: Validate the Maps page
    let validation = await validateMapsPage(page, entityName, auditedHost);
    console.log(
      `[SiteCheck] Q3 — Maps validation (attempt 1): ` +
        `title="${validation.pageTitle}", profile=${validation.isBusinessProfile}, ` +
        `geoPage=${validation.isGenericGeoPage}, website="${validation.websiteField}", ` +
        `matches=${validation.websiteMatches}`,
    );

    // ── HARD FAIL RETRY: If we landed on a generic geo page, try clicking ──
    // deeper results or searching with a more specific query
    if (validation.isGenericGeoPage) {
      console.log(
        `[SiteCheck] Q3 — ❌ Landed on generic geo page "${validation.pageTitle}". ` +
          `Retrying with more specific query...`,
      );

      // Retry 1: Try clicking the 2nd or 3rd result in the sidebar
      let retried = false;
      try {
        const results = page.locator('a[href*="/maps/place/"], div.Nv2PK a, a.hfpxzc');
        const count = await results.count();
        for (let i = 1; i < Math.min(count, 4); i++) {
          await recorder?.setCaption(`Q3 — Generic location page detected, trying Maps result #${i + 1}…`);
          await clickWithHighlight(results.nth(i));
          await page.waitForTimeout(4000);
          const recheck = await validateMapsPage(page, entityName, auditedHost);
          if (!recheck.isGenericGeoPage) {
            validation = recheck;
            retried = true;
            console.log(
              `[SiteCheck] Q3 — ✅ Found business profile on result #${i + 1}: "${recheck.pageTitle}"`,
            );
            break;
          }
        }
      } catch {
        /* couldn't click other results */
      }

      // Retry 2: Search with "entity name + website" to be more specific
      if (!retried) {
        try {
          const specificUrl = `https://www.google.com/maps/search/${encodeURIComponent(entityName + ' website')}`;
          await page.goto(specificUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(async () => {
            await page.goto(specificUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          });
          await page.waitForTimeout(5000);

          // Click first result
          try {
            const firstResult = page.locator('a[href*="/maps/place/"], div.Nv2PK a, a.hfpxzc').first();
            if (await firstResult.isVisible({ timeout: 3000 })) {
              await clickWithHighlight(firstResult);
              await page.waitForTimeout(5000);
            }
          } catch { /* */ }

          const recheck = await validateMapsPage(page, entityName, auditedHost);
          if (!recheck.isGenericGeoPage) {
            validation = recheck;
            console.log(
              `[SiteCheck] Q3 — ✅ Specific search found profile: "${recheck.pageTitle}"`,
            );
          } else {
            console.log(`[SiteCheck] Q3 — ❌ Specific search still shows geo page.`);
          }
        } catch {
          /* specific search failed */
        }
      }
    }

    // Step 4: Take screenshot — but ONLY if not a geo page
    if (validation.isGenericGeoPage) {
      await recorder?.setCaption(
        `Q3 — ✗ Only a generic location page ("${validation.pageTitle}") was found — no business profile`,
      );
      // Take screenshot anyway for evidence, but it will be marked as a fail
      await takeScreenshot(page, ss.abs);

      // Navigate back
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(3000);
      } catch { /* */ }

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

    // Valid profile — take evidence screenshot
    await recorder?.setCaption(
      validation.isBusinessProfile && validation.websiteMatches
        ? `Q3 — ✓ Maps profile "${validation.pageTitle}" lists the official website`
        : validation.isBusinessProfile && validation.websiteField
        ? `Q3 — ✗ Maps profile "${validation.pageTitle}" lists a DIFFERENT website`
        : validation.isBusinessProfile
        ? `Q3 — ✗ Maps profile "${validation.pageTitle}" has no website listed`
        : `Q3 — ✗ No recognizable business profile found on Google Maps`,
    );
    await takeScreenshot(page, ss.abs);

    // Step 5: Navigate back
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(3000);
    } catch {
      /* best effort */
    }

    // Step 6: Determine result
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

    // Navigate back
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(3000);
    } catch {
      /* best effort */
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
  previousResults: CriterionResult[];
  recorder?: EvidenceRecorder;
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, entityName, recorder } = params;
  const results: CriterionResult[] = [];

  await recorder?.setCaption(`Pillar 1 — Discovery & Access: automated check for "${entityName}"`);

  // Q1a is manual-only (entity category selection), skip it
  results.push(makeResult('Q1a', {
    status: 'na',
    notes: 'Manual criterion — entity category selection done by evaluator.',
    recommendation: '',
  }));

  results.push(await checkQ1(page, url, auditJobId, entityName, recorder));
  results.push(await checkQ1b(page, url, auditJobId, entityName, recorder));
  results.push(await checkQ3(page, url, auditJobId, entityName, recorder));

  await recorder?.setCaption('Pillar 1 — Discovery & Access: checks complete');
  return results;
}
