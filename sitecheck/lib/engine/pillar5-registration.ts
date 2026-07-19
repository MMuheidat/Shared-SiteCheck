// lib/engine/pillar5-registration.ts — Registration (Ease of Use)
// Q23 (User Registration available), Q23a (UAE Pass), Q24 (Registration straightforward)
//
// All three are evidence-only (not scored). The three questions run as ONE
// continuous recorded journey: find the Sign up / Register (or Sign in) entry
// on the homepage, highlight and click it on camera, land on the login page
// (UAE gov sites often redirect straight to the UAE Pass SSO), verify UAE Pass,
// then focus the sign-in field to show the form being tried. Evidence
// cosmetics (captions, highlight holds, slow scrolls) are recorder-gated so
// non-recorded runs stay fast; grading is identical in both modes.

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import {
  navigateAndWait,
  takeHighlightedScreenshot,
  takeMultiHighlightScreenshot,
  dismissCookieBanner,
  openNavMenu,
} from '@/lib/engine/helpers';
import { clickWithHighlight, humanScrollVerify, type EvidenceRecorder } from '@/lib/engine/recording';

const PILLAR = 'Registration';

function dbg(msg: string): void {
  console.log(`[SiteCheck][P5] ${msg}`);
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

// Only ever passed through page.locator (takeHighlightedScreenshot) — the
// :has-text() entries are Playwright-only and would throw in querySelector.
const UAE_PASS_EVIDENCE_SELECTORS = [
  ...UAE_PASS_SELECTORS,
  'button:has-text("UAE PASS")', 'a:has-text("UAE PASS")',
  'button:has-text("UAE Pass")', 'a:has-text("UAE Pass")',
];

// Highlight candidates for the UAE Pass SSO page itself (sign-in redirected
// to uaepass.ae): prefer the login form / panel, fall back to branding.
const UAE_PASS_PAGE_SELECTORS = [
  'form', '[class*="login" i]', 'img[src*="uaepass" i]', 'main',
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

function isUaePassHost(u: string): boolean {
  try {
    return /(^|\.)uaepass\.ae$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────
//  Entry finder — prefers an explicit Sign up / Register control, falls back
//  to Sign in / Login. In-viewport only (a human must be able to click it
//  right now — Playwright isVisible() is true for off-canvas drawer links).
//  The winner is tagged data-sitecheck-regentry for highlighting/clicking.
// ────────────────────────────────────────────────────────────
type EntryKind = 'register' | 'login';
interface RegEntry { kind: EntryKind; href: string | null; text: string }

async function findRegistrationEntry(page: Page): Promise<RegEntry | null> {
  try {
    return await page.evaluate(() => {
      const registerText = /\b(sign\s?up|register|create\s+(an\s+)?account)\b/i;
      const registerAr = /إنشاء حساب|حساب جديد|سجل الآن/;
      const registerHref = /register|sign-?up|create-?account/i;
      const loginText = /\b(sign\s?in|log\s?in|login)\b/i;
      const loginAr = /تسجيل الدخول|دخول/;
      const loginHref = /log-?in|sign-?in|uaepass/i;
      // "Sign up for our newsletter" and friends must never win.
      const exclude = /log-?out|sign-?out|newsletter|subscribe|event|webinar/i;

      const cands: { el: HTMLElement; kind: 'register' | 'login'; text: string; top: number }[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('a, button, [role="button"]'))) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.right <= 0 || r.left >= window.innerWidth) continue;
        if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (text.length > 40) continue;
        const href = el instanceof HTMLAnchorElement ? (el.getAttribute('href') || '') : '';
        const aria = el.getAttribute('aria-label') || '';
        const hay = `${text} ${aria}`;
        if (exclude.test(hay) || exclude.test(href)) continue;
        let kind: 'register' | 'login' | null = null;
        if (registerText.test(hay) || registerAr.test(hay) || registerHref.test(href)) kind = 'register';
        else if (loginText.test(hay) || loginAr.test(hay) || loginHref.test(href)) kind = 'login';
        if (!kind) continue;
        cands.push({ el, kind, text: text || aria, top: r.top });
      }
      if (cands.length === 0) return null;
      // Register beats login; header region (top < 300) beats mid-page;
      // shorter text beats longer within the same rank.
      const rank = (c: { kind: string; top: number }) =>
        (c.kind === 'register' ? 0 : 2) + (c.top < 300 ? 0 : 1);
      cands.sort((a, b) => rank(a) - rank(b) || a.text.length - b.text.length);
      const win = cands[0];
      win.el.setAttribute('data-sitecheck-regentry', '1');
      let abs: string | null = null;
      if (win.el instanceof HTMLAnchorElement) {
        const raw = win.el.getAttribute('href') || '';
        if (raw && !raw.startsWith('#') && !raw.startsWith('javascript:')) {
          try { abs = new URL(raw, location.href).href; } catch { abs = null; }
        }
      }
      return { kind: win.kind, href: abs, text: win.text };
    });
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
//  Click a control on camera and wait out the navigation it triggers.
//  UAE Pass buttons may window.open — catch stray popups and replay the
//  visit on the recorded page so the destination lands on video.
//  Returns whether the click itself was performed.
// ────────────────────────────────────────────────────────────
async function clickAndSettle(
  page: Page,
  loc: ReturnType<Page['locator']>,
  recorder?: EvidenceRecorder,
): Promise<boolean> {
  let popup: Page | null = null;
  const popupHandler = (p: Page) => { popup = p; };
  page.context().once('page', popupHandler);

  let clicked = true;
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    // Force same-tab so the destination appears in the recorded page's video.
    await loc.evaluate((el) => {
      if (el instanceof HTMLAnchorElement) el.target = '_self';
    }).catch(() => {});
    if (recorder) {
      await clickWithHighlight(loc, { holdMs: 1000, timeout: 5000 });
    } else {
      await loc.click({ timeout: 5000 });
    }
  } catch {
    clicked = false;
  }
  // SSO redirect chains (site → id.uaepass.ae) need time to settle.
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* SPA */ }
  await page.waitForTimeout(2500);

  if (popup) {
    const p = popup as Page;
    await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    const popupUrl = p.url();
    await p.close().catch(() => {});
    dbg(`click opened a popup (${popupUrl.slice(0, 80)}) — replaying on the recorded page`);
    if (popupUrl && popupUrl !== 'about:blank') {
      await page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
  page.context().off('page', popupHandler);
  await dismissCookieBanner(page);
  return clicked;
}

// Open the login destination by clicking the tagged entry on camera.
async function openLoginDestination(
  page: Page,
  entry: RegEntry,
  recorder?: EvidenceRecorder,
): Promise<{ mode: 'navigated' | 'modal' | 'none' }> {
  const startUrl = page.url();
  const loc = page.locator('[data-sitecheck-regentry]').first();
  const clicked = await clickAndSettle(page, loc, recorder);
  if (!clicked && entry.href) {
    dbg('entry click failed — navigating to its href directly');
    await navigateAndWait(page, entry.href, { waitAfter: 3000 }).catch(() => {});
    await dismissCookieBanner(page);
  }

  if (page.url() !== startUrl) return { mode: 'navigated' };

  // Same URL — did the click open a login modal instead?
  const modal = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    if (Array.from(document.querySelectorAll('input[type="password"]')).some(visible)) return true;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i]')).filter(visible);
    return dialogs.some((d) => Array.from(d.querySelectorAll('input')).some(visible));
  }).catch(() => false);
  if (modal) return { mode: 'modal' };

  // SPA swallowed the click — try the href directly before giving up.
  if (entry.href && entry.href !== startUrl) {
    dbg('click did not open anything — trying the entry href directly');
    await navigateAndWait(page, entry.href, { waitAfter: 3000 }).catch(() => {});
    await dismissCookieBanner(page);
    if (page.url() !== startUrl) return { mode: 'navigated' };
  }
  return { mode: 'none' };
}

// ────────────────────────────────────────────────────────────
//  Q24 helpers — tag the sign-in form's visible text inputs so the "fill
//  bars" can be focused and highlighted. Identifier field (email / Emirates
//  ID / phone) is tagged "id", the rest "1".
// ────────────────────────────────────────────────────────────
async function tagLoginFields(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const idRx = /email|user|emirates|eid|phone|mobile|هوية|بريد|هاتف/i;
      const inputs = Array.from(document.querySelectorAll<HTMLElement>('input, textarea')).filter((el) => {
        if (el instanceof HTMLInputElement) {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          if (!['text', 'email', 'tel', 'number'].includes(t)) return false;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      });
      if (inputs.length === 0) return 0;
      const meta = (el: HTMLElement) =>
        [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('placeholder'), el.getAttribute('aria-label')]
          .filter(Boolean).join(' ');
      const idField = inputs.find((el) => idRx.test(meta(el))) ?? inputs[0];
      const picked = inputs.slice(0, 3);
      if (!picked.includes(idField)) picked[0] = idField;
      for (const el of picked) {
        el.setAttribute('data-sitecheck-q24field', el === idField ? 'id' : '1');
      }
      return picked.length;
    });
  } catch {
    return 0;
  }
}

async function untagLoginFields(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-sitecheck-q24field]'))) {
      el.removeAttribute('data-sitecheck-q24field');
    }
  }).catch(() => {});
}

// takeHighlightedScreenshot leaves its red outline behind (it only saves the
// original styles) — restore them so an earlier question's highlight doesn't
// bleed into the next screenshot.
async function clearStaleHighlights(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-orig-outline]'))) {
      el.style.outline = el.dataset.origOutline || '';
      el.style.outlineOffset = el.dataset.origOutlineOffset || '';
      el.style.boxShadow = el.dataset.origBoxShadow || '';
      delete el.dataset.origOutline;
      delete el.dataset.origOutlineOffset;
      delete el.dataset.origBoxShadow;
    }
    const label = document.getElementById('sitecheck-highlight-label');
    if (label) label.remove();
  }).catch(() => {});
}

// UAE Pass sign-in controls, in preference order (explicit sign-in phrasing
// first). Playwright-only :has-text() — page.locator use only.
const UAE_PASS_CLICK_SELECTORS = [
  'a:has-text("sign in with uae pass")', 'button:has-text("sign in with uae pass")',
  'a:has-text("login with uae pass")', 'button:has-text("login with uae pass")',
  'a[href*="uaepass" i]', 'button[class*="uaepass" i]',
  'a:has-text("uae pass")', 'button:has-text("uae pass")',
];

// Find a clickable UAE Pass sign-in control on the current page (skipping
// "Learn more about UAE PASS"-style informational links).
async function findUaePassSignIn(page: Page): Promise<ReturnType<Page['locator']> | null> {
  for (const sel of UAE_PASS_CLICK_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      const text = ((await loc.textContent().catch(() => '')) || '').trim();
      if (/learn|about|more info|know|اعرف|المزيد/i.test(text)) continue;
      return loc;
    } catch { /* :has-text may not match — try the next selector */ }
  }
  return null;
}

// Visible field count + multi-step wizard heuristic (grading inputs for Q24).
async function inspectRegForm(page: Page): Promise<{ fields: number; multiStep: boolean }> {
  return page.evaluate(() => {
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
}

// ────────────────────────────────────────────────────────────
//  The journey — Q23 → click entry → Q23a → Q24, one continuous recording.
// ────────────────────────────────────────────────────────────
async function runRegistrationJourney(
  page: Page,
  auditJobId: string,
  recorder?: EvidenceRecorder,
): Promise<CriterionResult[]> {
  const stampNote = () => (recorder ? ` [${recorder.stamp()}]` : '');
  const skipNote = 'Skipped — Q23 (User Registration) not available.';

  // ── Phase 1: Q23 on the homepage ──
  await recorder?.setCaption('Q23 — Looking for a Sign up / Register option…');
  dbg('Q23: scanning homepage for a registration entry…');
  const homepageUaePass = await detectUaePass(page).catch(() => ({ elements: 0, hasText: false }));
  const detect = await detectRegistration(page).catch(() => ({ elements: 0, hasText: false }));

  let entry = await findRegistrationEntry(page);
  if (!entry) {
    await recorder?.setCaption('Q23 — Checking the navigation menu for a sign-in option…');
    dbg('Q23: no entry in the viewport — trying the navigation menu');
    const opened = await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
    if (opened) {
      entry = await findRegistrationEntry(page);
      if (!entry) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
      }
    }
  }

  const ss23 = ssPath(auditJobId, '23');
  const q23Found = entry !== null || detect.elements > 0;
  let q23: CriterionResult;
  try {
    if (entry) {
      const kindLabel = entry.kind === 'register' ? 'Sign up / Register' : 'Sign in / Login';
      dbg(`Q23: entry found — "${entry.text}" (${entry.kind}) → ${entry.href ?? '(click-only)'}`);
      await recorder?.setCaption(`Q23 — ${kindLabel} option found — highlighting it…`);
      await takeHighlightedScreenshot(page, ss23.abs, ['[data-sitecheck-regentry]'], {
        contextualZoom: true,
        label: kindLabel,
        maxHighlightBox: { width: 400, height: 120 },
      });
      if (recorder) await page.waitForTimeout(1200);
      q23 = makeResult('Q23', {
        status: 'pass',
        screenshotPath: ss23.rel,
        notes: `User registration/login is available — "${entry.text}" ${entry.kind === 'register' ? 'registration' : 'sign-in'} control found on the homepage.${stampNote()}`,
        recommendation: '',
      });
    } else if (detect.elements > 0) {
      dbg(`Q23: no clickable entry, but ${detect.elements} login/register element(s) detected`);
      await takeHighlightedScreenshot(page, ss23.abs, REGISTRATION_SELECTORS, {
        contextualZoom: true,
        label: 'Login / Register',
        maxHighlightBox: { width: 400, height: 120 },
      });
      q23 = makeResult('Q23', {
        status: 'pass',
        screenshotPath: ss23.rel,
        notes: `User registration/login is available (${detect.elements} login/register element(s) detected; no viewport-visible control to click).${stampNote()}`,
        recommendation: '',
      });
    } else {
      dbg('Q23: no registration or sign-in option found');
      if (recorder) {
        await recorder.setCaption('Q23 — No registration or sign-in option found on this website');
        await page.waitForTimeout(1200);
      }
      await viewportShot(page, ss23.abs).catch(() => {});
      const textOnly = detect.hasText
        ? 'Login-related text found but no actionable sign-in/register control. '
        : 'No login or registration feature detected. ';
      q23 = makeResult('Q23', {
        status: 'fail',
        screenshotPath: ss23.rel,
        notes: `${textOnly}(If this is a business-only entity, mark as Not Applicable.)${stampNote()}`,
      });
    }
  } catch (err: unknown) {
    q23 = makeResult('Q23', { status: 'na', notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }

  if (!q23Found) {
    return [
      q23,
      makeResult('Q23a', { status: 'skipped', notes: skipNote }),
      makeResult('Q24', { status: 'skipped', notes: skipNote }),
    ];
  }

  // ── Phase 2: open the login destination on camera ──
  let mode: 'navigated' | 'modal' | 'none' = 'none';
  if (entry) {
    await recorder?.setCaption('Q23a — Opening the sign-in page to look for UAE Pass…');
    dbg(`Q23a: opening entry "${entry.text}"…`);
    mode = (await openLoginDestination(page, entry, recorder)).mode;
    dbg(`Q23a: destination mode = ${mode}, url = ${page.url().slice(0, 100)}`);
  }
  const onLoginPage = mode !== 'none';
  const where = onLoginPage ? 'sign-in page' : 'homepage';

  // ── Phase 3: Q23a — UAE Pass ──
  const ss23a = ssPath(auditJobId, '23a');
  let hasUaePass = false;
  let q23a: CriterionResult;
  try {
    if (isUaePassHost(page.url())) {
      const host = new URL(page.url()).hostname;
      dbg(`Q23a: landed directly on UAE Pass SSO (${host})`);
      await recorder?.setCaption('Q23a — Sign-in goes directly to UAE Pass — verifying the UAE Pass login page…');
      if (recorder) await humanScrollVerify(page, { maxSteps: 3, delayMs: 300 });
      const ok = await takeHighlightedScreenshot(page, ss23a.abs, UAE_PASS_PAGE_SELECTORS, {
        contextualZoom: true,
        label: 'UAE Pass Login',
        maxHighlightBox: { width: 900, height: 650 },
      });
      if (!ok) await viewportShot(page, ss23a.abs).catch(() => {});
      if (recorder) await page.waitForTimeout(1200);
      hasUaePass = true;
      q23a = makeResult('Q23a', {
        status: 'pass',
        screenshotPath: ss23a.rel,
        notes: `UAE Pass (Digital ID) login is available — sign-in redirects directly to UAE Pass SSO (${host}).${stampNote()}`,
        recommendation: '',
      });
    } else {
      const data = await detectUaePass(page).catch(() => ({ elements: 0, hasText: false }));
      const onPage = data.elements > 0 || data.hasText;
      const homepageHad = homepageUaePass.elements > 0 || homepageUaePass.hasText;
      if (onPage || homepageHad) {
        dbg(`Q23a: UAE Pass detected on the ${onPage ? where : 'homepage'}`);
        await recorder?.setCaption('Q23a — UAE Pass option found — highlighting it…');
        await takeHighlightedScreenshot(page, ss23a.abs, UAE_PASS_EVIDENCE_SELECTORS, {
          contextualZoom: true,
          label: 'UAE Pass',
          maxHighlightBox: { width: 500, height: 200 },
        });
        if (recorder) await page.waitForTimeout(1200);
        hasUaePass = true;
        q23a = makeResult('Q23a', {
          status: 'pass',
          screenshotPath: ss23a.rel,
          notes: `UAE Pass (Digital ID) login is available — detected on the ${onPage ? where : 'homepage'}.${stampNote()}`,
          recommendation: '',
        });
      } else {
        dbg('Q23a: no UAE Pass integration detected');
        if (recorder) {
          await recorder.setCaption(`Q23a — No UAE Pass option found on the ${where}`);
          await page.waitForTimeout(1200);
        }
        await viewportShot(page, ss23a.abs).catch(() => {});
        q23a = makeResult('Q23a', {
          status: 'fail',
          screenshotPath: ss23a.rel,
          notes: `No UAE Pass integration detected (checked the ${where}).${stampNote()}`,
        });
      }
    }
  } catch (err: unknown) {
    q23a = makeResult('Q23a', { status: 'na', notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }

  // ── Phase 4: Q24 — try the sign-in form, highlight the fill bars ──
  await recorder?.setCaption('Q24 — Trying the sign-in form — checking how straightforward it is…');
  dbg('Q24: inspecting the sign-in/registration form…');
  const ss24 = ssPath(auditJobId, '24');
  let q24: CriterionResult;
  try {
    let form = await inspectRegForm(page);

    // TAMM-style flow: the entity's login page is just a "Sign in with UAE
    // PASS" button — the actual fill bar lives on the UAE Pass SSO page. Try
    // the sign-in on camera (opening the SSO page only; no credentials are
    // ever entered and nothing is submitted).
    let openedSso = false;
    if (form.fields === 0 && hasUaePass && !isUaePassHost(page.url())) {
      const uaeBtn = await findUaePassSignIn(page);
      if (uaeBtn) {
        dbg('Q24: no fill bar on this page — opening the UAE Pass sign-in on camera');
        await recorder?.setCaption('Q24 — Trying to sign in with UAE Pass…');
        const before = page.url();
        await clickAndSettle(page, uaeBtn, recorder);
        if (page.url() !== before) {
          openedSso = true;
          form = await inspectRegForm(page).catch(() => form);
          dbg(`Q24: UAE Pass sign-in page opened (${page.url().slice(0, 80)})`);
        }
      }
    }

    // Clear any leftover Q23/Q23a highlight so the fill-bar evidence is clean.
    await clearStaleHighlights(page);
    const tagged = await tagLoginFields(page);
    dbg(`Q24: ${form.fields} visible field(s), multiStep=${form.multiStep}, tagged=${tagged}`);

    let interacted = false;
    if (recorder && tagged > 0) {
      // Focus the identifier field on camera — no typing, and never any
      // submit click (this code path must not attempt a real sign-in).
      const idField = page.locator('[data-sitecheck-q24field="id"]').first();
      try {
        await idField.scrollIntoViewIfNeeded().catch(() => {});
        await clickWithHighlight(idField, { holdMs: 1000, timeout: 3000 });
        interacted = true;
      } catch {
        dbg('Q24: could not focus the sign-in field — highlighting only');
      }
    }

    let captured = 0;
    if (tagged > 0) {
      captured = await takeMultiHighlightScreenshot(page, ss24.abs, [
        { selector: '[data-sitecheck-q24field="id"]', label: 'Sign-in field' },
        { selector: '[data-sitecheck-q24field="1"]', label: 'Form field' },
      ], {
        holdMs: recorder ? 1200 : 400,
        maxBox: { width: 900, height: 120 },
      });
    }
    if (captured === 0) await viewportShot(page, ss24.abs).catch(() => {});
    await untagLoginFields(page);

    const interactNote = openedSso
      ? ` Opened the UAE Pass sign-in page on camera${interacted ? ' and focused the identifier field' : ''} (nothing was submitted).`
      : interacted ? ' Focused the sign-in field on camera (nothing was submitted).' : '';

    // UAE Pass = one-step identity login → straightforward
    if (hasUaePass) {
      q24 = makeResult('Q24', {
        status: 'pass',
        screenshotPath: ss24.rel,
        notes: `Registration is straightforward — UAE Pass single-sign-on provides a one-step, identity-based registration/login.${interactNote}${stampNote()}`,
        recommendation: '',
      });
    } else if (form.fields === 0 && !onLoginPage) {
      q24 = makeResult('Q24', {
        status: 'na',
        screenshotPath: ss24.rel,
        notes: `Could not reach a registration form to assess (no login page found). Manual review recommended.${stampNote()}`,
      });
    } else if (form.fields >= 1 && form.fields <= 12 && !form.multiStep) {
      q24 = makeResult('Q24', {
        status: 'pass',
        screenshotPath: ss24.rel,
        notes: `Registration appears straightforward — a single-page form with ${form.fields} field(s), no multi-step wizard.${interactNote}${stampNote()}`,
        recommendation: '',
      });
    } else {
      q24 = makeResult('Q24', {
        status: 'fail',
        screenshotPath: ss24.rel,
        notes: `Registration may be lengthy — ${form.fields} form field(s)${form.multiStep ? ' and a multi-step process detected' : ''}.${interactNote}${stampNote()}`,
      });
    }
  } catch (err: unknown) {
    q24 = makeResult('Q24', { status: 'na', notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }

  return [q23, q23a, q24];
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
  recorder?: EvidenceRecorder;
}): Promise<CriterionResult[]> {
  const { page, auditJobId, entityName, recorder } = params;

  dbg(`Pillar 5 (Registration) starting for "${entityName}" — recorded: ${recorder ? 'yes' : 'no'}`);
  if (recorder) {
    await recorder.setCaption(`Pillar 5 — Registration: automated check for "${entityName}"`);
    await page.waitForTimeout(1200);
  }
  await dismissCookieBanner(page);

  const results = await runRegistrationJourney(page, auditJobId, recorder);

  if (recorder) {
    await recorder.setCaption('Pillar 5 — Registration checks complete');
    await page.waitForTimeout(1500);
  }
  dbg('Pillar 5 (Registration) complete');
  return results;
}
