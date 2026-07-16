// lib/engine/pillar5-registration.ts — Registration (Ease of Use)
// Q23 (User Registration available), Q23a (UAE Pass), Q24 (Registration straightforward)
//
// All three are evidence-only (not scored). The registration form and UAE Pass
// option almost always live on the LOGIN page, not the homepage, so this pillar
// follows the login/register entry point and evaluates the resulting page.

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeHighlightedScreenshot, dismissCookieBanner } from '@/lib/engine/helpers';

const PILLAR = 'Registration';

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

const REGISTRATION_SELECTORS = [
  'a[href*="register" i]', 'a[href*="signup" i]', 'a[href*="sign-up" i]',
  'a[href*="create-account" i]', 'a[href*="createaccount" i]',
  'a[href*="login" i]', 'a[href*="signin" i]', 'a[href*="sign-in" i]',
  'a[href*="account" i]', 'a[href*="uaepass" i]',
  'button[class*="login" i]', 'button[class*="signin" i]', 'button[class*="register" i]',
  '[aria-label*="sign in" i]', '[aria-label*="log in" i]', '[aria-label*="register" i]',
  '[class*="login" i]', '[class*="signin" i]', '[id*="login" i]', '[id*="signin" i]',
];

const UAE_PASS_SELECTORS = [
  'a[href*="uaepass" i]', 'a[href*="uae-pass" i]', 'a[href*="id.uae" i]',
  'a[href*="selfcare.uaepass" i]', 'a[href*="uaepass.ae" i]',
  'img[src*="uaepass" i]', 'img[src*="uae-pass" i]', 'img[alt*="uae pass" i]',
  'button[class*="uaepass" i]', 'button[class*="uae-pass" i]',
  '[class*="uaepass" i]', '[class*="uae-pass" i]', '[id*="uaepass" i]',
];

// Detect registration / login availability on the current page.
async function detectRegistration(page: Page): Promise<{ elements: number; hasText: boolean }> {
  return page.evaluate(() => {
    const loginElements = document.querySelectorAll(
      'a[href*="login" i], a[href*="signin" i], a[href*="sign-in" i], a[href*="register" i], ' +
      'a[href*="signup" i], a[href*="sign-up" i], a[href*="account" i], a[href*="uaepass" i], ' +
      'button[class*="login" i], button[class*="signin" i], button[class*="register" i], ' +
      '[class*="login" i], [class*="signin" i], [id*="login" i], [id*="signin" i]'
    ).length;
    const text = document.body.innerText.toLowerCase();
    const hasText =
      text.includes('login') || text.includes('log in') || text.includes('sign in') ||
      text.includes('register') || text.includes('sign up') || text.includes('create account') ||
      text.includes('تسجيل الدخول') || text.includes('إنشاء حساب') || text.includes('تسجيل');
    return { elements: loginElements, hasText };
  });
}

// Detect UAE Pass on the current page.
async function detectUaePass(page: Page): Promise<{ elements: number; hasText: boolean }> {
  return page.evaluate(() => {
    const els = document.querySelectorAll(
      'a[href*="uaepass" i], a[href*="uae-pass" i], a[href*="id.uae" i], a[href*="uaepass.ae" i], ' +
      'img[src*="uaepass" i], img[src*="uae-pass" i], img[alt*="uae pass" i], ' +
      '[class*="uaepass" i], [class*="uae-pass" i], [id*="uaepass" i]'
    ).length;
    const text = document.body.innerText.toLowerCase();
    const html = document.body.innerHTML.toLowerCase();
    const hasText =
      text.includes('uae pass') || text.includes('uaepass') || text.includes('الهوية الرقمية') ||
      html.includes('uaepass') || html.includes('uae-pass') || html.includes('id.uae');
    return { elements: els, hasText };
  });
}

// Find the login/register entry point on the homepage and return where it leads.
async function findLoginEntry(page: Page): Promise<{ href: string | null; selector: string | null }> {
  // Prefer explicit register/sign-in links (resolvable without a click)
  const linkSelectors = [
    'a[href*="register" i]', 'a[href*="signup" i]', 'a[href*="sign-up" i]',
    'a[href*="create-account" i]', 'a[href*="uaepass" i]',
    'a[href*="login" i]', 'a[href*="signin" i]', 'a[href*="sign-in" i]', 'a[href*="account" i]',
  ];
  for (const sel of linkSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      const href = await loc.getAttribute('href').catch(() => null);
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        try { return { href: new URL(href, page.url()).href, selector: sel }; } catch { /* ignore */ }
      }
      return { href: null, selector: sel }; // visible but needs a click
    }
  }
  // Fall back to buttons / aria-labelled controls that must be clicked
  const clickSelectors = [
    'button:has-text("Sign in")', 'button:has-text("Sign In")', 'button:has-text("Log in")',
    'button:has-text("Register")', 'button:has-text("تسجيل الدخول")',
    '[aria-label*="sign in" i]', '[aria-label*="log in" i]', '[aria-label*="register" i]',
    'button[class*="login" i]', 'button[class*="signin" i]',
  ];
  for (const sel of clickSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) return { href: null, selector: sel };
  }
  return { href: null, selector: null };
}

// ────────────────────────────────────────────────────────────
//  Q23 — User Registration available (Yes / No / NA-for-business)
// ────────────────────────────────────────────────────────────
async function checkQ23(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const data = await detectRegistration(page);
    const ss = ssPath(auditJobId, '23');
    await takeHighlightedScreenshot(page, ss.abs, REGISTRATION_SELECTORS, {
      contextualZoom: true,
      label: 'Login / Register',
      maxHighlightBox: { width: 400, height: 120 },
    });

    const found = data.elements > 0 || data.hasText;
    if (found) {
      return makeResult('Q23', {
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `User registration/login is available (${data.elements} login/register element(s) detected).`,
        recommendation: '',
      });
    }
    return makeResult('Q23', {
      status: 'fail',
      screenshotPath: ss.rel,
      notes: 'No login or registration feature detected. (If this is a business-only entity, mark as Not Applicable.)',
    });
  } catch (err: unknown) {
    return makeResult('Q23', { status: 'na', notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q23a — UAE Pass available (depends Q23)
//  Checks the login page (where UAE Pass normally appears) with a homepage
//  fallback.
// ────────────────────────────────────────────────────────────
async function checkQ23a(
  page: Page, auditJobId: string, q23Found: boolean, onLoginPage: boolean, homepageHadUaePass: boolean,
): Promise<CriterionResult> {
  if (!q23Found) {
    return makeResult('Q23a', { status: 'skipped', notes: 'Skipped — Q23 (User Registration) not available.' });
  }
  try {
    const data = await detectUaePass(page);
    const found = data.elements > 0 || data.hasText || homepageHadUaePass;

    const ss = ssPath(auditJobId, '23a');
    await takeHighlightedScreenshot(page, ss.abs, UAE_PASS_SELECTORS, {
      contextualZoom: true,
      label: 'UAE Pass',
      maxHighlightBox: { width: 500, height: 200 },
    });

    const where = onLoginPage ? 'login page' : 'homepage';
    if (found) {
      const src = data.elements > 0 || data.hasText ? where : 'homepage';
      return makeResult('Q23a', {
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `UAE Pass (Digital ID) login is available — detected on the ${src}.`,
        recommendation: '',
      });
    }
    return makeResult('Q23a', {
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `No UAE Pass integration detected (checked the ${where}).`,
    });
  } catch (err: unknown) {
    return makeResult('Q23a', { status: 'na', notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q24 — Registration straightforward and quick (depends Q23)
//  Automation proxy:
//   - UAE Pass single-sign-on ⇒ straightforward (one identity-based step).
//   - Otherwise a short single-page form (≤ 12 visible fields, not a long
//     multi-step wizard) ⇒ straightforward. Long/multi-step ⇒ not.
// ────────────────────────────────────────────────────────────
async function checkQ24(
  page: Page, auditJobId: string, q23Found: boolean, onLoginPage: boolean, hasUaePass: boolean,
): Promise<CriterionResult> {
  if (!q23Found) {
    return makeResult('Q24', { status: 'skipped', notes: 'Skipped — Q23 (User Registration) not available.' });
  }
  try {
    const form = await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const fields = Array.from(document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, select'
      )).filter(visible).length;

      const text = document.body.innerText.toLowerCase();
      const multiStep =
        /step\s*[1-9]/.test(text) || /\b[1-9]\s*(of|\/)\s*[1-9]\b/.test(text) ||
        text.includes('step 1') || text.includes('الخطوة') ||
        document.querySelectorAll('[class*="step" i], [class*="wizard" i], [class*="progress" i][class*="bar" i]').length > 2;
      return { fields, multiStep };
    });

    const ss = ssPath(auditJobId, '24');
    await viewportShot(page, ss.abs);

    // UAE Pass = one-step identity login → straightforward
    if (hasUaePass) {
      return makeResult('Q24', {
        status: 'pass',
        screenshotPath: ss.rel,
        notes: 'Registration is straightforward — UAE Pass single-sign-on provides a one-step, identity-based registration/login.',
        recommendation: '',
      });
    }

    if (form.fields === 0 && !onLoginPage) {
      return makeResult('Q24', {
        status: 'na',
        screenshotPath: ss.rel,
        notes: 'Could not reach a registration form to assess (no login page found). Manual review recommended.',
      });
    }

    const straightforward = form.fields >= 1 && form.fields <= 12 && !form.multiStep;
    if (straightforward) {
      return makeResult('Q24', {
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Registration appears straightforward — a single-page form with ${form.fields} field(s)${form.multiStep ? '' : ', no multi-step wizard'}.`,
        recommendation: '',
      });
    }
    return makeResult('Q24', {
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Registration may be lengthy — ${form.fields} form field(s)${form.multiStep ? ' and a multi-step process detected' : ''}.`,
    });
  } catch (err: unknown) {
    return makeResult('Q24', { status: 'na', notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar5Registration(params: {
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

  // Q23 on the homepage; also capture homepage UAE Pass presence + login entry
  const homepageUaePass = await detectUaePass(page);
  const loginEntry = await findLoginEntry(page);
  const q23 = await checkQ23(page, auditJobId);
  results.push(q23);
  const q23Found = q23.status === 'pass';

  // Follow the login/register entry point — UAE Pass and the form live there
  let onLoginPage = false;
  if (q23Found && (loginEntry.href || loginEntry.selector)) {
    try {
      if (loginEntry.href) {
        await navigateAndWait(page, loginEntry.href, { waitAfter: 3000 });
        onLoginPage = true;
      } else if (loginEntry.selector) {
        await page.locator(loginEntry.selector).first().click({ timeout: 3000 });
        await page.waitForTimeout(3000);
        try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
        onLoginPage = page.url() !== url;
      }
      await dismissCookieBanner(page);
    } catch { /* stay on homepage if navigation fails */ }
  }

  // Detect UAE Pass on whichever page we ended up on
  const currentUaePass = await detectUaePass(page);
  const hasUaePass =
    currentUaePass.elements > 0 || currentUaePass.hasText ||
    homepageUaePass.elements > 0 || homepageUaePass.hasText;

  results.push(await checkQ23a(page, auditJobId, q23Found, onLoginPage, homepageUaePass.elements > 0 || homepageUaePass.hasText));
  results.push(await checkQ24(page, auditJobId, q23Found, onLoginPage, hasUaePass));

  return results;
}
