// lib/engine/pillar4-navigation.ts — Navigation & Ease of Use
// Q12 (Social Media), Q13 (Search Bar), Q16 (Contact Details), Q17 (Feedback),
// Q17.1 (Feedback Easy), Q18 (Menu Labels), Q19 (Jargon), Q20 (Button Labels),
// Q21 (Search Results), Q22 (FAQ), Q30 (Back/Forward Navigation)
//
// EVIDENCE RULES (same as Pillar 2):
// - Medium-zoom viewport shots, never far-away full-page captures.
// - Highlight the specific element being scored, then clean up overlays.

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeHighlightedScreenshot, dismissCookieBanner } from '@/lib/engine/helpers';

// Login/authentication pages (e.g. UAE Pass) are exceptional — they are not
// expected to carry the site's standard chrome like the search bar.
const LOGIN_PAGE_RX = /login|log-in|signin|sign-in|signup|sign-up|register|auth|uaepass|account/i;

const PILLAR = 'Navigation';

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

function ssPath(auditJobId: string, name: string) {
  const fileName = `q${name}.png`;
  return {
    rel: `/screenshots/${auditJobId}/${fileName}`,
    abs: path.join(process.cwd(), 'public', 'screenshots', auditJobId, fileName),
  };
}

// Medium-zoom evidence shot: current viewport, height capped at 800px.
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
        !href.startsWith('mailto:') &&
        !/\.(pdf|png|jpg|jpeg|gif|svg|webp|css|js)(\?|$)/i.test(href) &&
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
//  Q12 — Social Media Links (3-tier per criteria sheet)
//  Available AND functional [2] / available but not functional [1] / none [0]
//  Functionality is verified by actually opening the links in a new tab and
//  confirming they land on the social platform.
// ────────────────────────────────────────────────────────────
const SOCIAL_DOMAINS = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'linkedin.com', 'youtube.com', 'tiktok.com', 'snapchat.com',
  'pinterest.com', 'whatsapp.com', 't.me',
];
const SOCIAL_CORES = [
  'twitter', 'x.com', 'facebook', 'instagram', 'linkedin',
  'youtube', 'tiktok', 'snapchat', 'pinterest', 'whatsapp', 't.me',
];

async function checkQ12(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const data = await page.evaluate((domains: string[]) => {
      const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const found: { platform: string; href: string }[] = [];
      for (const domain of domains) {
        const match = anchors.find(a => a.href.toLowerCase().includes(domain));
        if (match) found.push({ platform: domain, href: match.href });
      }
      return found;
    }, SOCIAL_DOMAINS);

    const ss = ssPath(auditJobId, '12');
    const socialSelectors = [
      ...SOCIAL_DOMAINS.map(d => `a[href*="${d}"]`),
      '[class*="social"] a', '[class*="social"]',
    ];
    await takeHighlightedScreenshot(page, ss.abs, socialSelectors, {
      contextualZoom: true,
      label: 'Social Media Links',
      maxHighlightBox: { width: 600, height: 200 },
    });

    if (data.length === 0) {
      return makeResult('Q12', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: 'No social media links found on the page.',
      });
    }

    // Functional test: open up to 2 of the links and confirm they land on a
    // social platform (redirects like twitter.com → x.com count as working).
    let tested = 0;
    let working = 0;
    const testResults: string[] = [];
    for (const link of data.slice(0, 2)) {
      const socialPage = await page.context().newPage();
      try {
        tested++;
        await socialPage.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await socialPage.waitForTimeout(1500);
        const finalUrl = socialPage.url().toLowerCase();
        const landed = SOCIAL_CORES.some(core => finalUrl.includes(core));
        if (landed) {
          working++;
          testResults.push(`${link.platform} ✓`);
        } else {
          testResults.push(`${link.platform} ✗ (redirected to ${finalUrl.slice(0, 60)})`);
        }
      } catch {
        testResults.push(`${link.platform} ✗ (failed to load)`);
      } finally {
        await socialPage.close().catch(() => null);
      }
    }

    const platforms = data.map(d => d.platform).join(', ');
    if (working > 0) {
      return makeResult('Q12', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Social media links available and functional. Platforms: ${platforms}. Tested: ${testResults.join(', ')}.`,
        recommendation: '',
      });
    }
    return makeResult('Q12', {
      scoreEarned: 1,
      status: 'partial',
      screenshotPath: ss.rel,
      notes: `Social media links present but could not be verified as functional. Platforms: ${platforms}. Tested ${tested}: ${testResults.join(', ')}.`,
    });
  } catch (err: unknown) {
    return makeResult('Q12', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q13 — Search Bar accessible on all pages (3-tier per criteria sheet)
//  Available on all pages [2] / homepage only [1] / no search bar [0]
//  Checks the homepage AND internal pages for the search control.
// ────────────────────────────────────────────────────────────
const SEARCH_EVIDENCE_SELECTORS = [
  'input[type="search"]', 'input[role="searchbox"]',
  'input[name*="search" i]', 'input[name="q" i]', 'input[name*="query" i]',
  'input[placeholder*="search" i]', 'input[placeholder*="بحث"]',
  'input[aria-label*="search" i]', 'input[aria-label*="بحث"]',
  'input[class*="search" i]',
  'form[role="search"]', '[role="search"]',
  'button[aria-label*="search" i]', 'button[title*="search" i]',
  'a[aria-label*="search" i]', '[aria-label*="search" i]',
  '[class*="search-icon"]', '[class*="search-btn"]', '[class*="search-button"]',
];

async function detectSearchOnPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // Includes attribute-labeled non-button elements and class-marked inputs —
    // some design systems (e.g. TAMM's ui-lib v3) render the search trigger as
    // a <div aria-label="header-search-button"> and mark the input only by class.
    const inputs = document.querySelectorAll(
      'input[type="search"], input[role="searchbox"], input[name*="search" i], input[name="q" i], ' +
      'input[name*="query" i], input[placeholder*="search" i], input[placeholder*="بحث"], ' +
      'input[aria-label*="search" i], input[aria-label*="بحث"], input[class*="search" i]'
    ).length;
    const forms = document.querySelectorAll('form[action*="search" i], form[role="search"], [role="search"]').length;
    const buttons = document.querySelectorAll(
      'button[aria-label*="search" i], button[title*="search" i], a[aria-label*="search" i], ' +
      '[aria-label*="search" i], [class*="search-icon"], [class*="search-btn"], [class*="search-button"]'
    ).length;
    return inputs + forms + buttons > 0;
  });
}

async function checkQ13(
  page: Page, url: string, auditJobId: string,
): Promise<{ result: CriterionResult; hasSearch: boolean }> {
  try {
    const onHomepage = await detectSearchOnPage(page);

    const ss = ssPath(auditJobId, '13');
    await takeHighlightedScreenshot(page, ss.abs, SEARCH_EVIDENCE_SELECTORS, {
      contextualZoom: true,
      label: 'Search Bar',
      maxHighlightBox: { width: 700, height: 120 },
    });

    // Check internal pages for the same search control.
    // Login/authentication pages (UAE Pass etc.) are excluded — they are
    // exceptional pages not expected to carry the search bar.
    const internalLinks = (await discoverInternalLinks(page, url, 4))
      .filter(l => !LOGIN_PAGE_RX.test(l))
      .slice(0, 2);
    let pagesChecked = 0;
    let pagesWithSearch = 0;
    let loginPagesSkipped = 0;
    const missingOn: string[] = [];
    for (const link of internalLinks) {
      try {
        await navigateAndWait(page, link, { waitAfter: 2000 });

        // The link may redirect to a login page (e.g. UAE Pass). The redirect is
        // client-side and can land AFTER navigation settles, so re-check the URL
        // after a grace period, then fall back to content signals (password
        // field / UAE Pass prompt on a sparse page).
        let isLogin = LOGIN_PAGE_RX.test(page.url());
        if (!isLogin) {
          await page.waitForTimeout(2000);
          isLogin = LOGIN_PAGE_RX.test(page.url());
        }
        if (!isLogin) {
          isLogin = await page.evaluate(() => {
            const body = document.body.innerText || '';
            const sparse = body.length < 4000;
            const pwd = !!document.querySelector('input[type="password"]');
            const uaePass = body.toLowerCase().includes('uae pass') || body.includes('الهوية الرقمية');
            const signInText = /\b(sign in|log in|login)\b/i.test(body.slice(0, 2000));
            return pwd || (sparse && (uaePass || signInText));
          });
        }
        if (isLogin) {
          loginPagesSkipped++;
          continue;
        }

        pagesChecked++;
        // Slow-rendering SPA headers: retry detection once before declaring missing
        let hasSearch = await detectSearchOnPage(page);
        if (!hasSearch) {
          await page.waitForTimeout(2500);
          hasSearch = await detectSearchOnPage(page);
        }
        if (hasSearch) pagesWithSearch++;
        else missingOn.push(page.url());
      } catch { /* skip */ }
    }
    if (pagesChecked > 0 || loginPagesSkipped > 0) await navigateAndWait(page, url);
    const loginNote = loginPagesSkipped > 0 ? ` (${loginPagesSkipped} login page(s) excluded as exceptional)` : '';
    const missingNote = missingOn.length > 0 ? ` Missing on: ${missingOn.join(', ')}.` : '';

    if (!onHomepage) {
      const result = makeResult('Q13', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: `No search bar found on the homepage. Internal pages with search: ${pagesWithSearch}/${pagesChecked}.`,
      });
      return { result, hasSearch: false };
    }

    if (pagesChecked === 0 || pagesWithSearch === pagesChecked) {
      const result = makeResult('Q13', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: pagesChecked === 0
          ? `Search bar found on the homepage; no internal pages could be checked (treated as consistent).${loginNote}`
          : `Search bar accessible on all checked pages (homepage + ${pagesChecked} internal).${loginNote}`,
        recommendation: '',
      });
      return { result, hasSearch: true };
    }

    const result = makeResult('Q13', {
      scoreEarned: 1,
      status: 'partial',
      screenshotPath: ss.rel,
      notes: `Search bar available on the homepage but missing on ${pagesChecked - pagesWithSearch} of ${pagesChecked} internal pages checked.${missingNote}${loginNote}`,
    });
    return { result, hasSearch: true };
  } catch (err: unknown) {
    return {
      result: makeResult('Q13', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` }),
      hasSearch: false,
    };
  }
}

// ────────────────────────────────────────────────────────────
//  Q16 — Contact Details (3-tier per criteria sheet)
//  All 3 details (phone, email, address/map) [2] / 1-2 details [1] / none [0]
//  Also follows the site's Contact page, where details usually live.
// ────────────────────────────────────────────────────────────
async function checkQ16(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const detectContactDetails = () => ({
      hasPhone:
        /(\+?\d[\d\-\s()]{7,}\d)/.test(document.body.innerText) ||
        !!document.querySelector('a[href^="tel:"]'),
      hasEmail:
        /[\w.-]+@[\w.-]+\.\w{2,}/.test(document.body.innerText) ||
        !!document.querySelector('a[href^="mailto:"]'),
      hasAddressOrMap: (() => {
        const t = document.body.innerText.toLowerCase();
        const keywords =
          t.includes('address') || t.includes('عنوان') ||
          t.includes('p.o. box') || t.includes('ص.ب');
        const structural = !!document.querySelector(
          'address, iframe[src*="maps"], a[href*="google.com/maps"], a[href*="maps.app.goo.gl"], a[href*="goo.gl/maps"]'
        );
        return keywords || structural;
      })(),
    });

    const home = await page.evaluate(detectContactDetails);

    // Follow the contact page if one is linked — details often live there
    const contactHref = await page.evaluate(() => {
      const a = document.querySelector(
        'a[href*="contact" i], a[href*="اتصل"], a[href*="تواصل"]'
      ) as HTMLAnchorElement | null;
      return a ? a.href : null;
    });

    let contactPage = { hasPhone: false, hasEmail: false, hasAddressOrMap: false };
    let contactPageChecked = false;
    if (contactHref && !(home.hasPhone && home.hasEmail && home.hasAddressOrMap)) {
      const cp = await page.context().newPage();
      try {
        await cp.goto(contactHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await cp.waitForTimeout(2500);
        contactPage = await cp.evaluate(detectContactDetails);
        contactPageChecked = true;
      } catch { /* best effort */ } finally {
        await cp.close().catch(() => null);
      }
    }

    const hasPhone = home.hasPhone || contactPage.hasPhone;
    const hasEmail = home.hasEmail || contactPage.hasEmail;
    const hasAddressOrMap = home.hasAddressOrMap || contactPage.hasAddressOrMap;
    const detailCount = [hasPhone, hasEmail, hasAddressOrMap].filter(Boolean).length;

    const ss = ssPath(auditJobId, '16');
    await takeHighlightedScreenshot(page, ss.abs, [
      'address', '[class*="contact"]', '[id*="contact"]',
      'a[href^="tel:"]', 'a[href^="mailto:"]',
      'a[href*="contact" i]', 'a[href*="اتصل"]', 'a[href*="تواصل"]',
      'iframe[src*="maps"]', 'footer',
    ], {
      contextualZoom: true,
      label: 'Contact Information',
    });

    const details = [
      hasPhone ? 'Phone ✓' : 'Phone ✗',
      hasEmail ? 'Email ✓' : 'Email ✗',
      hasAddressOrMap ? 'Address/Map ✓' : 'Address/Map ✗',
    ].join(', ');
    const source = contactPageChecked ? ' (homepage + contact page checked)' : ' (homepage checked)';

    if (detailCount === 3) {
      return makeResult('Q16', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Full contact details listed: ${details}${source}.`,
        recommendation: '',
      });
    }
    if (detailCount >= 1) {
      return makeResult('Q16', {
        scoreEarned: 1,
        status: 'partial',
        screenshotPath: ss.rel,
        notes: `Partial contact details (${detailCount} of 3): ${details}${source}.`,
      });
    }
    return makeResult('Q16', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `No contact details found: ${details}${source}.`,
    });
  } catch (err: unknown) {
    return makeResult('Q16', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q17 — Feedback Forms / Surveys available [1/0]
// ────────────────────────────────────────────────────────────
const FEEDBACK_SELECTORS = [
  'a[href*="feedback" i]', 'a[href*="survey" i]', 'a[href*="satisfaction" i]',
  '[class*="feedback"]', '[id*="feedback"]', '[class*="survey"]', '[id*="survey"]',
  'a[href*="rate" i]', '[class*="rating"]',
];

async function checkQ17(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const found = await page.evaluate(() => {
      const feedbackElements = document.querySelectorAll(
        'a[href*="feedback" i], a[href*="survey" i], a[href*="satisfaction" i], ' +
        '[class*="feedback"], [id*="feedback"], [class*="survey"], [id*="survey"], ' +
        'a[href*="rate" i], [class*="rating"]'
      );
      const text = document.body.innerText.toLowerCase();
      const hasFeedbackText =
        text.includes('feedback') || text.includes('التغذية الراجعة') ||
        text.includes('ملاحظات') || text.includes('تقييم') ||
        text.includes('رأيك') || text.includes('your opinion') ||
        text.includes('rate us') || text.includes('satisfaction');
      return { elements: feedbackElements.length, hasFeedbackText };
    });

    const ss = ssPath(auditJobId, '17');
    await takeHighlightedScreenshot(page, ss.abs, FEEDBACK_SELECTORS, {
      contextualZoom: true,
      label: 'Feedback / Survey',
      maxHighlightBox: { width: 500, height: 200 },
    });

    const passed = found.elements > 0 || found.hasFeedbackText;
    return makeResult('Q17', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Feedback elements: ${found.elements}. Feedback-related text: ${found.hasFeedbackText ? 'Yes' : 'No'}.`,
      recommendation: passed ? '' : getRecommendation('Q17'),
    });
  } catch (err: unknown) {
    return makeResult('Q17', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q17.1 — Feedback easy to find and complete [1/0] (depends Q17)
//  Easy to find: control sits in header/footer/nav or is a floating widget.
//  Easy to complete: the feedback page/embed contains a manageable form.
// ────────────────────────────────────────────────────────────
// Inspect an opened feedback page/modal for how completable it is.
// Runs via page.evaluate on whichever page holds the feedback UI, so it must
// be self-contained (no external references).
function inspectFeedbackForm() {
  const forms = Array.from(document.querySelectorAll('form'));
  let minFields = 0;
  for (const f of forms) {
    const fields = f.querySelectorAll('input:not([type="hidden"]), textarea, select').length;
    if (fields > 0 && (minFields === 0 || fields < minFields)) minFields = fields;
  }
  const hasEmbed = !!document.querySelector(
    'iframe[src*="survey" i], iframe[src*="forms" i], iframe[src*="feedback" i]'
  );
  // Rating widgets: emoji/smiley/star scales used instead of form fields
  const hasRatingUI = !!document.querySelector(
    '[class*="rating" i], [class*="rate" i], [class*="emoji" i], [class*="smiley" i], ' +
    '[class*="stars" i], [class*="nps" i], input[type="radio"][name*="rate" i]'
  );
  // Survey dialog: question text plus a Next/Submit action
  const bodyStart = (document.body.innerText || '').slice(0, 5000).toLowerCase();
  const surveyText =
    bodyStart.includes('rate your experience') || bodyStart.includes('feedback') ||
    bodyStart.includes('survey') || bodyStart.includes('satisf') ||
    bodyStart.includes('تقييم') || bodyStart.includes('استبيان') || bodyStart.includes('رأيك');
  const actionButton = Array.from(
    document.querySelectorAll('button, [role="button"], input[type="submit"]')
  ).some(b => {
    const t = (b.textContent || '').trim().toLowerCase();
    return ['next', 'submit', 'send', 'التالي', 'إرسال', 'متابعة'].some(k => t === k || t.includes(k));
  });
  return { formFields: minFields, hasEmbed, hasRatingUI, hasSurveyDialog: surveyText && actionButton };
}

async function checkQ17_1(page: Page, auditJobId: string, q17Passed: boolean): Promise<CriterionResult> {
  if (!q17Passed) {
    return makeResult('Q17.1', { status: 'skipped', notes: 'Skipped — Q17 did not pass.' });
  }
  try {
    const findability = await page.evaluate(() => {
      const sels =
        'a[href*="feedback" i], a[href*="survey" i], a[href*="satisfaction" i], ' +
        '[class*="feedback"], [id*="feedback"], [class*="survey"], [id*="survey"]';
      const els = Array.from(document.querySelectorAll(sels));
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (el.closest('header, footer, nav, [role="banner"], [role="contentinfo"], [role="navigation"]')) {
          return { prominent: true, how: 'located in header/footer/navigation' };
        }
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.position === 'fixed' || style.position === 'sticky') {
          return { prominent: true, how: 'floating widget' };
        }
      }
      return { prominent: false, how: els.length ? 'present but buried in page content' : 'not found' };
    });

    const feedbackHref = await page.evaluate(() => {
      const a = document.querySelector(
        'a[href*="feedback" i], a[href*="survey" i], a[href*="satisfaction" i]'
      ) as HTMLAnchorElement | null;
      return a ? a.href : null;
    });

    const ss = ssPath(auditJobId, '17_1');
    let formInfo = { formFields: 0, hasEmbed: false, hasRatingUI: false, hasSurveyDialog: false, checked: false };
    let evidenceCaptured = false;
    let openMethod = '';

    // Preferred path: OPEN the feedback destination and screenshot the actual
    // form/modal (distinct from Q17, which only highlights the link).
    if (feedbackHref) {
      const fp = await page.context().newPage();
      try {
        await fp.goto(feedbackHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Survey modals (e.g. TAMM's "Rate Your Experience") open after a delay
        await fp.waitForTimeout(4000);
        await dismissCookieBanner(fp);
        await fp.waitForTimeout(500);
        formInfo = { ...(await fp.evaluate(inspectFeedbackForm)), checked: true };
        await viewportShot(fp, ss.abs);
        evidenceCaptured = true;
        openMethod = 'opened via feedback link';
      } catch { /* fall through to click path */ } finally {
        await fp.close().catch(() => null);
      }
    }

    // Fallback: no link — click the in-page feedback control to open its
    // widget/modal, then screenshot the result.
    if (!evidenceCaptured) {
      let clicked = false;
      for (const sel of FEEDBACK_SELECTORS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          try {
            await loc.click({ timeout: 2000 });
            clicked = true;
            await page.waitForTimeout(2500);
            break;
          } catch { /* try next */ }
        }
      }
      await dismissCookieBanner(page);
      await page.waitForTimeout(300);
      if (clicked) {
        formInfo = { ...(await page.evaluate(inspectFeedbackForm)), checked: true };
        openMethod = 'opened via in-page feedback control';
      }
      await viewportShot(page, ss.abs);
      evidenceCaptured = true;
    }

    // Completable: a manageable form, an embedded survey, a rating widget
    // (emoji/star scales), or a survey dialog.
    const completable = formInfo.checked
      ? (formInfo.formFields >= 1 && formInfo.formFields <= 20) ||
        formInfo.hasEmbed || formInfo.hasRatingUI || formInfo.hasSurveyDialog
      : findability.prominent;

    const formNote = formInfo.checked
      ? ` Feedback ${openMethod}: form fields: ${formInfo.formFields}` +
        `${formInfo.hasEmbed ? ', embedded survey' : ''}` +
        `${formInfo.hasRatingUI ? ', rating widget (emoji/star scale)' : ''}` +
        `${formInfo.hasSurveyDialog ? ', survey dialog with Next/Submit' : ''}.`
      : ' Could not open the feedback form to inspect it.';

    if (findability.prominent && completable) {
      return makeResult('Q17.1', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Feedback is easy to find (${findability.how}) and complete.${formNote}`,
        recommendation: '',
      });
    }
    return makeResult('Q17.1', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Feedback found but not easy to find/complete — ${findability.how}.${formNote}`,
    });
  } catch (err: unknown) {
    return makeResult('Q17.1', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q18 — Clear Menu Labels [1/0]
// ────────────────────────────────────────────────────────────
async function checkQ18(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const data = await page.evaluate(() => {
      const navItems = Array.from(
        document.querySelectorAll('nav a, header a, [role="navigation"] a, [role="menuitem"]'),
      );
      const labels = navItems
        .map((el) => (el as HTMLElement).textContent?.trim() ?? '')
        .filter((t) => t.length > 0);

      const vagueTerms = [
        'miscellaneous', 'other', 'more', 'stuff', 'click here', 'link',
        'page', 'أخرى', 'متفرقات', 'المزيد',
      ];
      const vagueLabels = labels.filter((l) =>
        vagueTerms.some((vt) => l.toLowerCase() === vt),
      );
      const tooShort = labels.filter((l) => l.length === 1);
      const tooLong = labels.filter((l) => l.length > 50);

      return {
        totalLabels: labels.length,
        vagueCount: vagueLabels.length,
        vagueLabels,
        tooShort: tooShort.length,
        tooLong: tooLong.length,
      };
    });

    const ss = ssPath(auditJobId, '18');
    await takeHighlightedScreenshot(page, ss.abs, ['nav', 'header nav', '[role="navigation"]', 'header'], {
      contextualZoom: true,
      label: 'Main Menu',
    });

    const passed =
      data.totalLabels > 0 &&
      data.vagueCount === 0 &&
      data.tooShort === 0 &&
      data.tooLong === 0;

    return makeResult('Q18', {
      scoreEarned: passed ? 1 : 0,
      status: data.totalLabels === 0 ? 'fail' : passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Menu items: ${data.totalLabels}. Vague labels: ${data.vagueCount}${data.vagueLabels.length ? ' (' + data.vagueLabels.join(', ') + ')' : ''}. Too short: ${data.tooShort}. Too long: ${data.tooLong}.`,
      recommendation: passed ? '' : getRecommendation('Q18'),
    });
  } catch (err: unknown) {
    return makeResult('Q18', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q19 — Content Free from Jargon [1/0]
// ────────────────────────────────────────────────────────────
async function checkQ19(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const data = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const jargonTerms = [
        'hereinafter', 'whereas', 'notwithstanding', 'aforementioned',
        'pursuant to', 'in accordance with', 'therein', 'thereof',
        'heretofore', 'ipso facto', 'inter alia',
      ];
      const found = jargonTerms.filter((term) => text.includes(term));
      const wordCount = text.split(/\s+/).length;
      return { jargonFound: found, wordCount };
    });

    const ss = ssPath(auditJobId, '19');
    await viewportShot(page, ss.abs);

    const jargonRatio = data.wordCount > 0 ? data.jargonFound.length / data.wordCount : 0;
    const passed = data.jargonFound.length <= 2 && jargonRatio < 0.001;

    return makeResult('Q19', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Jargon terms found: ${data.jargonFound.length}${data.jargonFound.length ? ' (' + data.jargonFound.join(', ') + ')' : ''}. Total words: ${data.wordCount}.`,
      recommendation: passed ? '' : getRecommendation('Q19'),
    });
  } catch (err: unknown) {
    return makeResult('Q19', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q20 — Clear Buttons and Links [1/0]
// ────────────────────────────────────────────────────────────
async function checkQ20(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const data = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));

      const vagueTexts = ['click here', 'here', 'read more', 'more', 'link', 'اضغط هنا', 'هنا'];

      const totalLinks = anchors.length;
      const vagueLinks = anchors.filter((a) => {
        const text = a.textContent?.trim().toLowerCase() ?? '';
        return vagueTexts.includes(text) || text.length === 0;
      });

      const totalButtons = buttons.length;
      const emptyButtons = buttons.filter((b) => {
        const text = (b as HTMLElement).textContent?.trim() ?? '';
        const ariaLabel = b.getAttribute('aria-label')?.trim() ?? '';
        const title = b.getAttribute('title')?.trim() ?? '';
        return text.length === 0 && ariaLabel.length === 0 && title.length === 0;
      });

      return {
        totalLinks,
        vagueLinks: vagueLinks.length,
        totalButtons,
        emptyButtons: emptyButtons.length,
      };
    });

    const ss = ssPath(auditJobId, '20');
    await viewportShot(page, ss.abs);

    const vagueRatio = data.totalLinks > 0 ? data.vagueLinks / data.totalLinks : 0;
    const emptyButtonRatio = data.totalButtons > 0 ? data.emptyButtons / data.totalButtons : 0;
    const passed = vagueRatio <= 0.15 && emptyButtonRatio <= 0.1;

    return makeResult('Q20', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Links: ${data.totalLinks} (vague: ${data.vagueLinks}). Buttons: ${data.totalButtons} (empty: ${data.emptyButtons}).`,
      recommendation: passed ? '' : getRecommendation('Q20'),
    });
  } catch (err: unknown) {
    return makeResult('Q20', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q21 — Search results relevant and accurate (3-tier, depends Q13)
//  Relevant and working [2] / relevant but pages not working [1] / none [0]
//  Performs a real search and opens the first result to verify it works.
// ────────────────────────────────────────────────────────────
async function checkQ21(
  page: Page, url: string, auditJobId: string, hasSearch: boolean,
): Promise<CriterionResult> {
  if (!hasSearch) {
    return makeResult('Q21', { status: 'skipped', notes: 'Skipped — no search bar found (Q13).' });
  }
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
    // The search field may be hidden behind a search icon — click to reveal
    if (!inputSel) {
      for (const sel of OPENER_SELECTORS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          try {
            await loc.click({ timeout: 2000 });
            await page.waitForTimeout(1500);
            inputSel = await findVisibleInput();
            if (inputSel) break;
          } catch { /* try next opener */ }
        }
      }
    }

    const ss = ssPath(auditJobId, '21');
    if (!inputSel) {
      await viewportShot(page, ss.abs);
      await navigateAndWait(page, url);
      return makeResult('Q21', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: 'Search control exists but no usable search input could be reached to perform a query.',
      });
    }

    // Type the query and submit
    const input = page.locator(inputSel).first();
    await input.click({ timeout: 3000 }).catch(() => {});
    await input.fill(query, { timeout: 3000 });
    await input.press('Enter').catch(() => {});
    await page.waitForTimeout(3000);
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA search */ }

    // Detect results
    const results = await page.evaluate((q: string) => {
      const currentUrl = location.href.toLowerCase();
      const urlLooksSearch =
        currentUrl.includes('search') || currentUrl.includes('q=') || currentUrl.includes('query');
      const containers = document.querySelectorAll(
        '[class*="result" i], [id*="result" i], main, [role="main"], body'
      );
      const links = new Set<string>();
      const texts: string[] = [];
      for (const c of containers) {
        for (const a of Array.from(c.querySelectorAll('a[href]'))) {
          const text = (a.textContent || '').trim();
          const href = (a as HTMLAnchorElement).href;
          if (text.length >= 15 && href.startsWith(location.origin) && !href.includes('#') && !links.has(href)) {
            links.add(href);
            texts.push(text.toLowerCase());
          }
        }
        if (links.size > 0 && c !== document.body) break; // prefer a dedicated results container
      }
      const bodyLower = document.body.innerText.toLowerCase();
      const noResults =
        bodyLower.includes('no results') || bodyLower.includes('nothing found') ||
        bodyLower.includes('لا توجد نتائج') || bodyLower.includes('0 results');
      const mentionsQuery = texts.some(t => t.includes(q.toLowerCase())) || bodyLower.includes(q.toLowerCase());
      return { urlLooksSearch, resultLinks: Array.from(links).slice(0, 3), noResults, mentionsQuery };
    }, query);

    // Evidence: the search results page itself (banner-free)
    await dismissCookieBanner(page);
    await page.waitForTimeout(500);
    await viewportShot(page, ss.abs);

    const hasResults = !results.noResults && results.resultLinks.length > 0;

    if (!hasResults) {
      await navigateAndWait(page, url);
      return makeResult('Q21', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: `Searched for "${query}" but no results were shown${results.noResults ? ' (explicit no-results message)' : ''}.`,
      });
    }

    // Verify the first result actually opens
    let firstResultWorks = false;
    try {
      await page.goto(results.resultLinks[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      firstResultWorks = await page.evaluate(() => (document.body.innerText || '').trim().length > 200);
    } catch { /* result page failed to load */ }

    await navigateAndWait(page, url);

    if (firstResultWorks) {
      return makeResult('Q21', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Search for "${query}" returned ${results.resultLinks.length}+ relevant results and the first result page loads correctly.${results.mentionsQuery ? '' : ' (Note: result text did not explicitly contain the query term.)'}`,
        recommendation: '',
      });
    }
    return makeResult('Q21', {
      scoreEarned: 1,
      status: 'partial',
      screenshotPath: ss.rel,
      notes: `Search for "${query}" returned results, but the first result page failed to load or was empty.`,
    });
  } catch (err: unknown) {
    await navigateAndWait(page, url).catch(() => {});
    return makeResult('Q21', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q22 — FAQ easy to find and navigate (3-tier per criteria sheet)
//  Available and easy to find [2] / available but not easy [1] / none [0]
//  Easy to find = an FAQ link in the header/nav/footer of the homepage.
// ────────────────────────────────────────────────────────────
async function checkQ22(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const data = await page.evaluate(() => {
      const isFaqLink = (a: Element) => {
        const href = (a.getAttribute('href') || '').toLowerCase();
        const text = (a.textContent || '').toLowerCase();
        return href.includes('faq') || href.includes('frequently') || href.includes('أسئلة') ||
          text.includes('faq') || text.includes('frequently asked') ||
          text.includes('الأسئلة الشائعة') || text.includes('أسئلة متكررة');
      };
      const navAnchors = Array.from(
        document.querySelectorAll('header a, nav a, footer a, [role="banner"] a, [role="navigation"] a, [role="contentinfo"] a')
      );
      const inNav = navAnchors.some(isFaqLink);

      // FAQ is often hosted under a Support/Help section of the site
      const supportAnchor = navAnchors.find(a => {
        const href = ((a as HTMLAnchorElement).href || '').toLowerCase();
        const text = (a.textContent || '').toLowerCase();
        return ['support', 'help', 'المساعدة', 'الدعم', 'مساعدة'].some(k => text.includes(k) || href.includes(k));
      }) as HTMLAnchorElement | undefined;

      const anyFaqLink = Array.from(document.querySelectorAll('a')).some(isFaqLink);
      const faqSections = document.querySelectorAll(
        '[class*="faq" i], [id*="faq" i], [class*="frequently" i], [id*="frequently" i]'
      ).length;
      const text = document.body.innerText.toLowerCase();
      const hasFaqText =
        text.includes('frequently asked') || text.includes('faq') ||
        text.includes('الأسئلة الشائعة') || text.includes('أسئلة متكررة');

      return { inNav, supportHref: supportAnchor?.href ?? null, anyFaqLink, faqSections, hasFaqText };
    });

    const ss = ssPath(auditJobId, '22');

    if (data.inNav) {
      await takeHighlightedScreenshot(page, ss.abs, [
        'header a[href*="faq" i]', 'nav a[href*="faq" i]', 'footer a[href*="faq" i]',
        'a[href*="faq" i]', 'a[href*="أسئلة"]', '[class*="faq" i]',
      ], {
        contextualZoom: true,
        label: 'FAQ',
        maxHighlightBox: { width: 500, height: 150 },
      });
      return makeResult('Q22', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: 'FAQ link available in the header/navigation/footer — easy to find.',
        recommendation: '',
      });
    }

    // No direct FAQ link — check the Support/Help section, where FAQ
    // commonly lives (e.g. TAMM's Support menu).
    if (data.supportHref) {
      const sp = await page.context().newPage();
      try {
        await sp.goto(data.supportHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sp.waitForTimeout(3000);
        await dismissCookieBanner(sp);

        const faqOnSupport = await sp.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          const hasFaqText =
            text.includes('frequently asked') || text.includes('faq') ||
            text.includes('الأسئلة الشائعة') || text.includes('أسئلة متكررة');
          const faqSections = document.querySelectorAll(
            '[class*="faq" i], [id*="faq" i], details, [class*="accordion" i]'
          ).length;
          return { hasFaqText, faqSections };
        });

        if (faqOnSupport.hasFaqText || faqOnSupport.faqSections > 0) {
          await takeHighlightedScreenshot(sp, ss.abs, [
            'h1:has-text("Frequently Asked")', 'h2:has-text("Frequently Asked")',
            'h1:has-text("الأسئلة الشائعة")', 'h2:has-text("الأسئلة الشائعة")',
            '[class*="faq" i]', '[id*="faq" i]', '[class*="accordion" i]',
          ], {
            contextualZoom: true,
            label: 'FAQ Section',
          });
          return makeResult('Q22', {
            scoreEarned: 2,
            status: 'pass',
            screenshotPath: ss.rel,
            notes: 'FAQ easily reachable via the Support/Help menu — FAQ section found on the support page.',
            recommendation: '',
          });
        }
      } catch { /* best effort */ } finally {
        await sp.close().catch(() => null);
      }
    }

    await takeHighlightedScreenshot(page, ss.abs, [
      'a[href*="faq" i]', 'a[href*="أسئلة"]', '[class*="faq" i]',
    ], {
      contextualZoom: true,
      label: 'FAQ',
      maxHighlightBox: { width: 500, height: 150 },
    });

    if (data.anyFaqLink || data.faqSections > 0 || data.hasFaqText) {
      return makeResult('Q22', {
        scoreEarned: 1,
        status: 'partial',
        screenshotPath: ss.rel,
        notes: `FAQ content exists but is not linked from the header/nav/footer or Support section — available but not easy to find. (Links: ${data.anyFaqLink ? 'yes' : 'no'}, sections: ${data.faqSections}, text: ${data.hasFaqText ? 'yes' : 'no'}.)`,
      });
    }
    return makeResult('Q22', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: ss.rel,
      notes: 'No FAQ section, link, or related content found (homepage and Support section checked).',
    });
  } catch (err: unknown) {
    return makeResult('Q22', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q30 — Smooth Navigation with back AND forward buttons [1/0]
//  Navigates to an internal page, then verifies browser back and forward
//  both restore the expected pages.
// ────────────────────────────────────────────────────────────
async function checkQ30(page: Page, url: string, auditJobId: string): Promise<CriterionResult> {
  try {
    const data = await page.evaluate(() => {
      const breadcrumbs = document.querySelectorAll(
        '[class*="breadcrumb"], [id*="breadcrumb"], nav[aria-label*="breadcrumb"], [class*="crumb"]',
      ).length;
      const backToTop = document.querySelectorAll(
        '[class*="back-to-top"], [class*="backtotop"], [class*="scroll-top"], [id*="back-to-top"], a[href="#top"]',
      ).length;
      const sitemap = document.querySelectorAll('a[href*="sitemap"], a[href*="site-map"]').length;
      const activeMenu = document.querySelectorAll(
        '[class*="active"], [aria-current="page"], [class*="current"]',
      ).length;
      return { breadcrumbs, backToTop, sitemap, activeMenu };
    });

    const candidates = await discoverInternalLinks(page, url, 1);
    const targetLink = candidates[0] ?? null;

    let backWorks = false;
    let forwardWorks = false;
    const startUrl = page.url();
    // SPAs rewrite URLs on restore (trailing slashes, locale prefixes, query
    // params) — compare leniently instead of demanding exact equality.
    const norm = (u: string) => u.split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();

    if (targetLink) {
      try {
        await page.goto(targetLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
        const internalUrl = page.url();
        if (norm(internalUrl) !== norm(startUrl)) {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          await page.waitForTimeout(2000);
          backWorks = norm(page.url()) === norm(startUrl);

          await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          await page.waitForTimeout(2000);
          // Forward works if we returned to the internal page — or at minimum
          // moved off the homepage to a same-origin page (SPA URL rewriting).
          const nowUrl = page.url();
          forwardWorks =
            norm(nowUrl) === norm(internalUrl) ||
            (norm(nowUrl) !== norm(startUrl) && nowUrl.startsWith(new URL(startUrl).origin));
        }
      } catch { /* navigation failed */ }
    }

    // Return to the homepage for subsequent checks
    await navigateAndWait(page, url);

    const ss = ssPath(auditJobId, '30');
    await viewportShot(page, ss.abs);

    const structuralEvidence = data.breadcrumbs + data.backToTop + data.sitemap + data.activeMenu;
    const passed = backWorks && forwardWorks;

    return makeResult('Q30', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Browser back button: ${backWorks ? 'works' : 'failed'}. Forward button: ${forwardWorks ? 'works' : 'failed'}. ` +
        `Navigation aids — breadcrumbs: ${data.breadcrumbs}, back-to-top: ${data.backToTop}, sitemap: ${data.sitemap}, active menu states: ${data.activeMenu}.`,
      recommendation: passed ? '' : getRecommendation('Q30'),
    });
  } catch (err: unknown) {
    return makeResult('Q30', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar4Navigation(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId } = params;
  const results: CriterionResult[] = [];

  // Clear cookie banners before any evidence screenshots
  await dismissCookieBanner(page);

  results.push(await checkQ12(page, auditJobId));

  const q13 = await checkQ13(page, url, auditJobId);
  results.push(q13.result);

  results.push(await checkQ16(page, auditJobId));

  const q17 = await checkQ17(page, auditJobId);
  results.push(q17);
  results.push(await checkQ17_1(page, auditJobId, q17.status === 'pass'));

  results.push(await checkQ18(page, auditJobId));
  results.push(await checkQ19(page, auditJobId));
  results.push(await checkQ20(page, auditJobId));
  results.push(await checkQ22(page, auditJobId));

  // Q21 and Q30 navigate away from the homepage — run them last
  results.push(await checkQ21(page, url, auditJobId, q13.hasSearch));
  results.push(await checkQ30(page, url, auditJobId));

  return results;
}
