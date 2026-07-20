// lib/engine/pillar8-privacy.ts — Customer Privacy (recorded journey)
// Q35.1 (Privacy policy available — same site [1] / directs to TAMM [1] / none [0])
// Q35   (Policy easy to find and clearly explains data handling — depends Q35.1)
// Q36   (Secure registration/login — depends Q23 from the Registration pillar)
//
// On camera (recorder page): scroll to the footer to find the Privacy Policy
// (site-search fallback), hover+highlight+click it, scroll the policy content,
// then open the sign-in page and show a security panel with the real TLS cert.
// Off camera: a strict certificate probe in a temp context (the recording
// context ignores HTTPS errors, so it can't judge cert validity itself).

import type { Browser, BrowserContext, Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { takeHighlightedScreenshot, dismissCookieBanner, humanNavigate } from '@/lib/engine/helpers';
import {
  type EvidenceRecorder,
  clickWithHighlight,
  humanScrollVerify,
  showTitleCard,
  hideTitleCard,
  showSecurityPanel,
  hideSecurityPanel,
} from '@/lib/engine/recording';

const PILLAR = 'Customer Privacy';

// Terminal progress log (mirrors Pillar 4/7) so the evaluator can follow the run.
function dbg(msg: string): void {
  console.log(`[SiteCheck][P8] ${msg}`);
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

function ssPath(auditJobId: string, name: string) {
  const fileName = `q${name}.png`;
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

// Lightweight nav for on-camera resets — avoids the 30s networkidle stall that
// SPA gov sites (e.g. TAMM) trigger under navigateAndWait. Mirrors Pillar 7.
async function gotoLight(page: Page, target: string, waitAfter = 1200): Promise<void> {
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch {
    try { await page.goto(target, { waitUntil: 'commit', timeout: 15000 }); } catch { /* */ }
  }
  await page.waitForTimeout(waitAfter);
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}
const isTammHost = (h: string) => h.includes('tamm.abudhabi') || h === 'tamm.ae' || h.endsWith('.tamm.ae');

const PRIVACY_LINK_SELECTORS = [
  'footer a[href*="privacy" i]', 'footer a[href*="خصوصية"]',
  'a[href*="privacy" i]', 'a[href*="خصوصية"]',
  'a:has-text("Privacy Policy")', 'a:has-text("سياسة الخصوصية")',
];

interface PolicyPageData {
  reachable: boolean;
  destination: 'same_site' | 'tamm' | 'other_external' | 'none';
  topicsCovered: string[];
  textLength: number;
}

// In-page scan for privacy links + where they live (footer/header).
async function scanPrivacyLinks(page: Page): Promise<{ links: string[]; inFooter: boolean; inHeader: boolean }> {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
    const isPrivacy = (a: HTMLAnchorElement) => {
      const href = a.href?.toLowerCase() ?? '';
      const text = a.textContent?.toLowerCase().trim() ?? '';
      return href.includes('privacy') || href.includes('خصوصية') ||
        text.includes('privacy') || text.includes('سياسة الخصوصية') || text.includes('الخصوصية');
    };
    const links = anchors.filter(isPrivacy).map(a => a.href).filter(Boolean);
    const inFooter = Array.from(document.querySelectorAll('footer a, [role="contentinfo"] a'))
      .some(a => isPrivacy(a as HTMLAnchorElement));
    const inHeader = Array.from(document.querySelectorAll('header a, [role="banner"] a'))
      .some(a => isPrivacy(a as HTMLAnchorElement));
    return { links: Array.from(new Set(links)).slice(0, 3), inFooter, inHeader };
  }).catch(() => ({ links: [] as string[], inFooter: false, inHeader: false }));
}

// Secondary attempt: use the site search bar to find a privacy link.
async function findPrivacyViaSearch(page: Page, recorder?: EvidenceRecorder): Promise<string[]> {
  try {
    const isArabic = await page.evaluate(
      () => /[؀-ۿ]/.test(document.body.innerText.substring(0, 2000)),
    ).catch(() => false);
    const query = isArabic ? 'الخصوصية' : 'privacy';

    const INPUT_SELECTORS = [
      'input[type="search"]', 'input[role="searchbox"]',
      'input[name*="search" i]', 'input[name="q" i]', 'input[name*="query" i]',
      'input[placeholder*="search" i]', 'input[placeholder*="بحث"]',
      'input[aria-label*="search" i]', 'input[aria-label*="بحث"]', 'input[class*="search" i]',
    ];
    const OPENER_SELECTORS = [
      'button[aria-label*="search" i]', 'button[title*="search" i]',
      'a[aria-label*="search" i]', '[aria-label*="search" i]',
      '[class*="search-icon"]', '[class*="search-btn"]', '[class*="search-button"]',
    ];
    const findInput = async (): Promise<string | null> => {
      for (const sel of INPUT_SELECTORS) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) return sel;
      }
      return null;
    };

    let inputSel = await findInput();
    if (!inputSel) {
      for (const sel of OPENER_SELECTORS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          try {
            if (recorder) await clickWithHighlight(loc, { holdMs: 700 });
            else await loc.click({ timeout: 2000 });
            await page.waitForTimeout(1200);
            inputSel = await findInput();
            if (inputSel) break;
          } catch { /* try next */ }
        }
      }
    }
    if (!inputSel) return [];

    const input = page.locator(inputSel).first();
    await input.click({ timeout: 3000 }).catch(() => {});
    if (recorder) await input.pressSequentially(query, { delay: 70 }).catch(() => input.fill(query).catch(() => {}));
    else await input.fill(query, { timeout: 3000 });
    await input.press('Enter').catch(() => {});
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* SPA */ }
    await page.waitForTimeout(1500);

    const scan = await scanPrivacyLinks(page);
    return scan.links;
  } catch {
    return [];
  }
}

const PRIVACY_TOPICS_EVAL = () => {
  const text = document.body.innerText.toLowerCase();
  const topics: Record<string, boolean> = {
    'data collection': text.includes('collect') || text.includes('نجمع') || text.includes('جمع البيانات'),
    'data use': text.includes('use of') || text.includes('how we use') || text.includes('استخدام البيانات') || text.includes('نستخدم'),
    'data sharing': text.includes('share') || text.includes('third part') || text.includes('مشاركة') || text.includes('أطراف ثالثة'),
    'cookies': text.includes('cookie') || text.includes('ملفات تعريف الارتباط'),
    'security': text.includes('security') || text.includes('protect') || text.includes('الأمان') || text.includes('حماية'),
    'user rights': text.includes('your rights') || text.includes('access your') || text.includes('حقوقك'),
    'retention': text.includes('retention') || text.includes('retain') || text.includes('الاحتفاظ'),
    'contact': text.includes('contact us') || text.includes('اتصل بنا') || text.includes('تواصل معنا'),
  };
  return {
    covered: Object.entries(topics).filter(([, v]) => v).map(([k]) => k),
    textLength: (document.body.innerText || '').trim().length,
    isPrivacyContent: text.includes('privacy') || text.includes('الخصوصية'),
  };
};

// ────────────────────────────────────────────────────────────
//  Q35.1 (recorded) — find + open the privacy policy; feeds Q35
// ────────────────────────────────────────────────────────────
interface Q35State {
  result: CriterionResult;
  policy: PolicyPageData;
  foundInFooter: boolean;
  foundViaSearch: boolean;
  onPolicyPage: boolean;
}

async function checkQ35_1(
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<Q35State> {
  const policy: PolicyPageData = { reachable: false, destination: 'none', topicsCovered: [], textLength: 0 };
  try {
    await recorder?.setCaption('Q35.1 — Looking for the Privacy Policy in the footer…');
    dbg('Q35.1: scrolling to footer to find the privacy policy');
    if (recorder) await humanScrollVerify(page, { maxSteps: 6, delayMs: 350, returnToTop: false });

    const scan = await scanPrivacyLinks(page);
    let links = scan.links;
    const foundInFooter = scan.inFooter;
    let foundViaSearch = false;

    if (!scan.inFooter && !scan.inHeader) {
      // Not in the footer/header — try the site search bar as a secondary attempt.
      await recorder?.setCaption('Q35.1 — Not in the footer — trying the site search…');
      dbg('Q35.1: privacy link not in footer/header — trying site search');
      const viaSearch = await findPrivacyViaSearch(page, recorder);
      if (viaSearch.length) { links = viaSearch; foundViaSearch = true; }
    }

    // Evidence: highlight the link where the user finds it.
    const ss = ssPath(auditJobId, '35.1');
    await takeHighlightedScreenshot(page, ss.abs, PRIVACY_LINK_SELECTORS, {
      contextualZoom: true,
      label: 'Privacy Policy Link',
      maxHighlightBox: { width: 400, height: 100 },
    });

    let onPolicyPage = false;
    if (links.length > 0) {
      await recorder?.setCaption('Q35.1 — Opening the Privacy Policy…');
      dbg(`Q35.1: opening privacy link ${links[0]}`);
      // Hover + highlight + click on camera; fall back to a direct goto.
      try {
        const u = new URL(links[0]);
        const anchor = page.locator(`a[href="${links[0]}"], a[href="${u.pathname + u.search}"]`).first();
        if (await anchor.isVisible().catch(() => false)) {
          await anchor.hover({ timeout: 2000 }).catch(() => {});
          await anchor.evaluate((el: Element) => { (el as HTMLAnchorElement).target = '_self'; }).catch(() => {});
          if (recorder) await clickWithHighlight(anchor, { holdMs: 1000, timeout: 5000 });
          else await anchor.click({ timeout: 5000 });
          try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch { /* */ }
        } else {
          await humanNavigate(page, links[0], recorder);
        }
      } catch {
        try { await page.goto(links[0], { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { /* */ }
      }
      await page.waitForTimeout(2500);
      await dismissCookieBanner(page);

      const analysis = await page.evaluate(PRIVACY_TOPICS_EVAL).catch(() => null);
      if (analysis && analysis.isPrivacyContent) {
        policy.reachable = true;
        policy.topicsCovered = analysis.covered;
        policy.textLength = analysis.textLength;
        const destHost = hostOf(page.url());
        policy.destination =
          destHost === hostOf(url) ? 'same_site' :
          isTammHost(destHost) ? 'tamm' : 'other_external';
        onPolicyPage = true;
        dbg(`Q35.1: policy reachable, destination=${policy.destination}, topics=${policy.topicsCovered.length}`);
      } else {
        dbg('Q35.1: opened link is not recognizable privacy content');
      }
    }

    if (policy.reachable) {
      const flavor = policy.destination === 'same_site'
        ? 'Yes — keeps me on the same website'
        : policy.destination === 'tamm'
          ? 'Yes — directs me to the TAMM website'
          : 'Yes — hosted on an external site';
      await recorder?.setCaption(`Q35.1 — Privacy Policy found. ${flavor}.`);
      if (recorder) await page.waitForTimeout(1200);
      return {
        result: makeResult('Q35.1', {
          scoreEarned: 1,
          status: 'pass',
          screenshotPath: ss.rel,
          notes: `Privacy policy is available. ${flavor}. Found via ${foundViaSearch ? 'site search' : foundInFooter ? 'footer' : 'a page link'}. (${links.length} privacy link(s) found.)`,
          recommendation: '',
        }),
        policy, foundInFooter, foundViaSearch, onPolicyPage,
      };
    }

    // Not available
    if (recorder) {
      await showTitleCard(page, 'No privacy policy could be found on this website');
      await page.waitForTimeout(2500);
      await hideTitleCard(page);
    }
    return {
      result: makeResult('Q35.1', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: links.length > 0
          ? `Privacy link(s) found (${links.length}) but the policy page could not be reached or contains no privacy content.`
          : 'No privacy policy link found in the footer, header, or via the site search.',
      }),
      policy, foundInFooter, foundViaSearch, onPolicyPage: false,
    };
  } catch (err: unknown) {
    return {
      result: makeResult('Q35.1', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` }),
      policy, foundInFooter: false, foundViaSearch: false, onPolicyPage: false,
    };
  }
}

// ────────────────────────────────────────────────────────────
//  Q35 (recorded) — easy to find AND clearly explains data handling
// ────────────────────────────────────────────────────────────
async function runQ35(
  page: Page, auditJobId: string, state: Q35State, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  if (state.result.status !== 'pass') {
    return makeResult('Q35', {
      status: 'skipped',
      notes: 'Skipped — Q35.1 (Privacy Policy Available) did not pass.',
    });
  }
  // "Easy to find" (per brief) = discoverable via the footer or the site search.
  const easyToFind = state.foundInFooter || state.foundViaSearch;
  const clearlyExplains = state.policy.topicsCovered.length >= 3 && state.policy.textLength >= 800;
  const passed = easyToFind && clearlyExplains;

  await recorder?.setCaption('Q35 — Reading the policy to check it clearly explains data handling…');
  dbg(`Q35: easyToFind=${easyToFind}, clearlyExplains=${clearlyExplains}`);
  if (recorder && state.onPolicyPage) {
    await humanScrollVerify(page, { maxSteps: 4, delayMs: 450, returnToTop: false });
  }
  const ss = ssPath(auditJobId, '35');
  await viewportShot(page, ss.abs);

  const notes =
    `Easy to find: ${easyToFind ? `Yes (via ${state.foundViaSearch ? 'site search' : 'footer'})` : 'No (not in footer or via search)'}. ` +
    `Clearly explains data handling: ${clearlyExplains ? 'Yes' : 'No'} — covers ${state.policy.topicsCovered.length}/8 topics ` +
    `(${state.policy.topicsCovered.join(', ') || 'none'}), ${state.policy.textLength} characters of policy text.`;

  return makeResult('Q35', {
    scoreEarned: passed ? 1 : 0,
    status: passed ? 'pass' : 'fail',
    screenshotPath: ss.rel,
    notes,
    recommendation: passed ? '' : getRecommendation('Q35'),
  });
}

// ────────────────────────────────────────────────────────────
//  Strict TLS certificate probe (hidden — the recording context ignores
//  HTTPS errors, so it cannot judge cert validity itself)
// ────────────────────────────────────────────────────────────
interface CertInfo {
  valid: boolean;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  protocol: string | null;
  note: string | null;
}

async function probeCertificate(page: Page, targetUrl: string): Promise<CertInfo> {
  const info: CertInfo = { valid: false, issuer: null, validFrom: null, validTo: null, protocol: null, note: null };
  if (!/^https:/i.test(targetUrl)) { info.note = 'URL is not HTTPS'; return info; }
  const browser: Browser | null = page.context().browser();
  if (!browser) { info.valid = true; info.note = 'certificate not independently verified (no browser handle)'; return info; }

  let ctx: BrowserContext | null = null;
  try {
    ctx = await browser.newContext({ ignoreHTTPSErrors: false });
    const p = await ctx.newPage();
    let response;
    try {
      response = await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ERR_CERT|SSL|certificate|ERR_SSL/i.test(msg)) {
        info.note = `certificate error: ${msg.substring(0, 90)}`;
        return info; // decisive: insecure
      }
      // Non-cert failure (timeout/WAF) — inconclusive, don't fail Q36 on this alone.
      info.valid = true;
      info.note = 'certificate not independently verified (login page did not load in the strict probe)';
      return info;
    }
    const sd = response ? await response.securityDetails().catch(() => null) : null;
    if (sd) {
      info.issuer = sd.issuer || null;
      info.protocol = sd.protocol || null;
      const vf = sd.validFrom;
      const vt = sd.validTo;
      info.validFrom = vf ? new Date(vf * 1000).toISOString().slice(0, 10) : null;
      info.validTo = vt ? new Date(vt * 1000).toISOString().slice(0, 10) : null;
      const notExpired = !vt || vt * 1000 > Date.now();
      info.valid = notExpired;
      if (!notExpired) info.note = 'certificate has expired';
    } else {
      // Loaded over HTTPS in a strict context with no cert error → trusted.
      info.valid = true;
    }
    return info;
  } catch {
    info.valid = true;
    info.note = 'certificate probe could not complete';
    return info;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────
//  Q36 (recorded) — secure registration/login (depends Q23)
// ────────────────────────────────────────────────────────────
async function checkQ36(
  page: Page, url: string, auditJobId: string, previousResults: CriterionResult[], recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  try {
    // NA: the entity's site directs entirely to TAMM (Tamm security is out of scope).
    const currentHost = hostOf(page.url());
    const auditedHost = hostOf(url);
    if (auditedHost && currentHost && auditedHost !== currentHost && isTammHost(currentHost)) {
      await recorder?.setCaption('Q36 — Sign-in is handled by TAMM — out of scope (Not applicable).');
      return makeResult('Q36', {
        status: 'na',
        notes: 'Not applicable — the entity website directs to the TAMM website (per criteria sheet).',
      });
    }

    // Dependency: Q23 (registration available) from the Registration pillar.
    const q23 = previousResults.find(r => r.qid === 'Q23');
    let registrationAvailable: boolean;
    if (q23) {
      registrationAvailable = q23.status === 'pass';
    } else {
      registrationAvailable = await page.evaluate(() => {
        const els = document.querySelectorAll(
          'a[href*="login" i], a[href*="signin" i], a[href*="register" i], a[href*="signup" i], ' +
          'button[class*="login" i], button[class*="signin" i], [aria-label*="sign in" i], [aria-label*="log in" i]'
        ).length;
        const text = document.body.innerText.toLowerCase();
        return els > 0 || text.includes('sign in') || text.includes('log in') || text.includes('تسجيل الدخول');
      }).catch(() => false);
    }
    if (!registrationAvailable) {
      return makeResult('Q36', {
        status: 'skipped',
        notes: 'Skipped — Q23 (User Registration) not available on this website.',
      });
    }

    // Reach the sign-in page on camera (never enter credentials).
    await recorder?.setCaption('Q36 — Opening the sign-in / registration page…');
    const loginHref = await page.evaluate(() => {
      const a = document.querySelector(
        'a[href*="login" i], a[href*="signin" i], a[href*="sign-in" i], a[href*="register" i], a[href*="uaepass" i]'
      ) as HTMLAnchorElement | null;
      return a && a.href && !a.href.startsWith('javascript:') ? a.href : null;
    }).catch(() => null);

    let onLoginPage = false;
    if (loginHref) {
      dbg(`Q36: navigating to login ${loginHref}`);
      try { await humanNavigate(page, loginHref, recorder); onLoginPage = true; } catch { /* */ }
    } else {
      const CLICKERS = [
        'button:has-text("Sign in")', 'button:has-text("Log in")', 'button:has-text("تسجيل الدخول")',
        '[aria-label*="sign in" i]', '[aria-label*="log in" i]', 'button[class*="login" i]', 'button[class*="signin" i]',
      ];
      for (const sel of CLICKERS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          try {
            if (recorder) await clickWithHighlight(loc, { holdMs: 1000, timeout: 4000 });
            else await loc.click({ timeout: 3000 });
            await page.waitForTimeout(2500);
            try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
            onLoginPage = true;
            break;
          } catch { /* try next */ }
        }
      }
    }
    await dismissCookieBanner(page);

    const loginUrl = page.url();
    // Strict certificate probe (hidden context) — the real security verdict.
    const cert = await probeCertificate(page, loginUrl);
    dbg(`Q36: cert valid=${cert.valid} issuer=${cert.issuer ?? 'n/a'} validTo=${cert.validTo ?? 'n/a'}`);

    // On-page security signals.
    const sec = await page.evaluate(() => {
      const isHttps = location.protocol === 'https:';
      const pwdFields = Array.from(document.querySelectorAll('input[type="password"]'));
      const unmaskedPwd = Array.from(document.querySelectorAll(
        'input[name*="password" i]:not([type="password"]), input[placeholder*="password" i]:not([type="password"])'
      )).filter(el => (el as HTMLInputElement).type === 'text').length;
      const html = document.body.innerHTML.toLowerCase();
      const text = document.body.innerText.toLowerCase();
      const hasUaePass =
        html.includes('uaepass') || html.includes('uae-pass') || html.includes('id.uae') ||
        text.includes('uae pass') || text.includes('الهوية الرقمية');
      return { isHttps, passwordFields: pwdFields.length, unmaskedPwd, hasUaePass };
    }).catch(() => ({ isHttps: /^https:/i.test(loginUrl), passwordFields: 0, unmaskedPwd: 0, hasUaePass: false }));
    const loginHost = hostOf(loginUrl);
    const viaUaePassDomain = loginHost.includes('uaepass');

    const secure =
      sec.isHttps &&
      cert.valid &&
      sec.unmaskedPwd === 0 &&
      (sec.hasUaePass || viaUaePassDomain || sec.passwordFields > 0 || onLoginPage);

    // Security panel overlay (the padlock substitute), held on camera.
    await recorder?.setCaption('Q36 — Verifying the connection is secure…');
    if (recorder) {
      await showSecurityPanel(page, {
        url: loginUrl,
        secure,
        issuer: cert.issuer,
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        protocol: cert.protocol,
        note: cert.note,
      });
      await page.waitForTimeout(4000);
    }
    const ss = ssPath(auditJobId, '36');
    await viewportShot(page, ss.abs);
    if (recorder) await hideSecurityPanel(page);

    // Restore the homepage for later pillars.
    try { await gotoLight(page, url, 1500); await dismissCookieBanner(page); } catch { /* */ }

    const signals: string[] = [];
    signals.push(`HTTPS: ${sec.isHttps ? 'Yes' : 'NO'}`);
    signals.push(`Certificate: ${cert.valid ? 'valid, unexpired' : 'INVALID/insecure'}${cert.issuer ? ` (${cert.issuer})` : ''}${cert.validTo ? `, expires ${cert.validTo}` : ''}`);
    if (cert.protocol) signals.push(cert.protocol);
    if (sec.hasUaePass || viaUaePassDomain) signals.push('UAE Pass federated login (secure digital identity)');
    if (sec.passwordFields > 0) signals.push(`${sec.passwordFields} masked password field(s)`);
    if (sec.unmaskedPwd > 0) signals.push(`${sec.unmaskedPwd} UNMASKED password field(s)`);
    if (!onLoginPage) signals.push('login page not reached — evaluated on the homepage');
    if (cert.note) signals.push(cert.note);

    if (secure) {
      return makeResult('Q36', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Secure registration/login in place — ${signals.join('; ')}.`,
        recommendation: '',
      });
    }
    return makeResult('Q36', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Login security concerns — ${signals.join('; ')}.`,
    });
  } catch (err: unknown) {
    return makeResult('Q36', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar8Privacy(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
  recorder?: EvidenceRecorder;
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, previousResults, recorder } = params;
  const results: CriterionResult[] = [];

  await dismissCookieBanner(page);

  // Q35.1 + Q35 (single policy visit feeds both)
  const state = await checkQ35_1(page, url, auditJobId, recorder);
  results.push(state.result);
  results.push(await runQ35(page, auditJobId, state, recorder));

  // Back to the homepage before Q36 so the TAMM-redirect NA check and the login
  // discovery run against the entity site, not the (possibly TAMM) policy page.
  try { await gotoLight(page, url, 1500); await dismissCookieBanner(page); } catch { /* */ }

  results.push(await checkQ36(page, url, auditJobId, previousResults, recorder));

  dbg(`done: Q35.1 ${results[0].status}, Q35 ${results[1].status}, Q36 ${results[2].status}`);
  return results;
}
