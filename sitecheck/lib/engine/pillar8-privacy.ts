// lib/engine/pillar8-privacy.ts — Customer Privacy
// Q35.1 (Privacy policy available — same site [1] / directs to TAMM [1] / none [0])
// Q35   (Policy easy to find and clearly explains data handling — depends Q35.1)
// Q36   (Secure registration/login — depends Q23 from the Registration pillar)

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeHighlightedScreenshot, dismissCookieBanner } from '@/lib/engine/helpers';

const PILLAR = 'Customer Privacy';

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

// ────────────────────────────────────────────────────────────
//  Q35.1 + policy-page analysis (single visit feeds both Q35.1 and Q35)
// ────────────────────────────────────────────────────────────
async function checkQ35_1(
  page: Page, url: string, auditJobId: string,
): Promise<{ result: CriterionResult; policy: PolicyPageData; inFooterOrHeader: boolean }> {
  const policy: PolicyPageData = { reachable: false, destination: 'none', topicsCovered: [], textLength: 0 };
  try {
    const data = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      const isPrivacy = (a: HTMLAnchorElement) => {
        const href = a.href?.toLowerCase() ?? '';
        const text = a.textContent?.toLowerCase().trim() ?? '';
        return href.includes('privacy') || href.includes('خصوصية') ||
          text.includes('privacy') || text.includes('سياسة الخصوصية') || text.includes('الخصوصية');
      };
      const links = anchors.filter(isPrivacy).map(a => a.href).filter(Boolean);
      const inFooterOrHeader = !!document.querySelector('footer, [role="contentinfo"], header, [role="banner"]') &&
        Array.from(document.querySelectorAll('footer a, [role="contentinfo"] a, header a, [role="banner"] a'))
          .some(a => isPrivacy(a as HTMLAnchorElement));
      return { links: Array.from(new Set(links)).slice(0, 3), inFooterOrHeader };
    });

    // Evidence: the privacy link highlighted where the user finds it
    const ss = ssPath(auditJobId, '35.1');
    await takeHighlightedScreenshot(page, ss.abs, PRIVACY_LINK_SELECTORS, {
      contextualZoom: true,
      label: 'Privacy Policy Link',
      maxHighlightBox: { width: 400, height: 100 },
    });

    // Follow the first privacy link and analyze the policy page
    const policyShot = ssPath(auditJobId, '35');
    if (data.links.length > 0) {
      try {
        const response = await page.goto(data.links[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
        await dismissCookieBanner(page);

        const ok = !!response && response.status() < 400;
        if (ok) {
          const analysis = await page.evaluate(() => {
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
          });

          if (analysis.isPrivacyContent) {
            policy.reachable = true;
            policy.topicsCovered = analysis.covered;
            policy.textLength = analysis.textLength;
            const destHost = hostOf(page.url());
            policy.destination =
              destHost === hostOf(url) ? 'same_site' :
              isTammHost(destHost) ? 'tamm' : 'other_external';

            // Evidence for Q35: the policy page content itself
            await viewportShot(page, policyShot.abs);
          }
        }
      } catch { /* policy page unreachable */ }
      try { await navigateAndWait(page, url, { waitAfter: 2000 }); await dismissCookieBanner(page); } catch { /* */ }
    }

    if (policy.reachable) {
      const flavor = policy.destination === 'same_site'
        ? 'Yes — keeps the user on the same website'
        : policy.destination === 'tamm'
          ? 'Yes — directs to the TAMM website'
          : 'Yes — hosted on an external site';
      return {
        result: makeResult('Q35.1', {
          scoreEarned: 1,
          status: 'pass',
          screenshotPath: ss.rel,
          notes: `Privacy policy is available. ${flavor}. (${data.links.length} privacy link(s) found.)`,
          recommendation: '',
        }),
        policy,
        inFooterOrHeader: data.inFooterOrHeader,
      };
    }
    return {
      result: makeResult('Q35.1', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: data.links.length > 0
          ? `Privacy link(s) found (${data.links.length}) but the policy page could not be reached or contains no privacy content.`
          : 'No privacy policy link found on the website.',
      }),
      policy,
      inFooterOrHeader: data.inFooterOrHeader,
    };
  } catch (err: unknown) {
    return {
      result: makeResult('Q35.1', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` }),
      policy,
      inFooterOrHeader: false,
    };
  }
}

// ────────────────────────────────────────────────────────────
//  Q35 — Easy to find AND clearly explains data handling (depends Q35.1)
// ────────────────────────────────────────────────────────────
function buildQ35(
  auditJobId: string, q35_1Passed: boolean, policy: PolicyPageData, inFooterOrHeader: boolean,
): CriterionResult {
  if (!q35_1Passed) {
    return makeResult('Q35', {
      status: 'skipped',
      notes: 'Skipped — Q35.1 (Privacy Policy Available) did not pass.',
    });
  }
  const ss = ssPath(auditJobId, '35');
  const clearlyExplains = policy.topicsCovered.length >= 3 && policy.textLength >= 800;
  const passed = inFooterOrHeader && clearlyExplains;

  const notes =
    `Easy to find: ${inFooterOrHeader ? 'Yes (link in footer/header)' : 'No (not in footer/header)'}. ` +
    `Clearly explains data handling: ${clearlyExplains ? 'Yes' : 'No'} — covers ${policy.topicsCovered.length}/8 topics ` +
    `(${policy.topicsCovered.join(', ') || 'none'}), ${policy.textLength} characters of policy text. ` +
    'Screenshot shows the policy page content.';

  return makeResult('Q35', {
    scoreEarned: passed ? 1 : 0,
    status: passed ? 'pass' : 'fail',
    screenshotPath: ss.rel,
    notes,
    recommendation: passed ? '' : getRecommendation('Q35'),
  });
}

// ────────────────────────────────────────────────────────────
//  Q36 — Secure registration / login (depends Q23 from Registration pillar)
// ────────────────────────────────────────────────────────────
async function checkQ36(
  page: Page, url: string, auditJobId: string, previousResults: CriterionResult[],
): Promise<CriterionResult> {
  try {
    // NA case from the criteria sheet: the entity's site directs to TAMM entirely
    const currentHost = hostOf(page.url());
    const auditedHost = hostOf(url);
    if (auditedHost && currentHost && auditedHost !== currentHost && isTammHost(currentHost)) {
      return makeResult('Q36', {
        status: 'na',
        notes: 'Not applicable — the entity website directs to the TAMM website (per criteria sheet).',
      });
    }

    // Dependency: Q23 (registration available) from the Registration pillar
    const q23 = previousResults.find(r => r.qid === 'Q23');
    let registrationAvailable: boolean;
    if (q23) {
      registrationAvailable = q23.status === 'pass';
    } else {
      // Q23 not run yet (single-pillar mode) — light local detection
      registrationAvailable = await page.evaluate(() => {
        const els = document.querySelectorAll(
          'a[href*="login" i], a[href*="signin" i], a[href*="register" i], a[href*="signup" i], ' +
          'button[class*="login" i], button[class*="signin" i], [aria-label*="sign in" i], [aria-label*="log in" i]'
        ).length;
        const text = document.body.innerText.toLowerCase();
        return els > 0 || text.includes('sign in') || text.includes('log in') || text.includes('تسجيل الدخول');
      });
    }
    if (!registrationAvailable) {
      return makeResult('Q36', {
        status: 'skipped',
        notes: 'Skipped — Q23 (User Registration) not available on this website.',
      });
    }

    // Reach the login page (link href first, then clickable button)
    const loginHref = await page.evaluate(() => {
      const a = document.querySelector(
        'a[href*="login" i], a[href*="signin" i], a[href*="sign-in" i], a[href*="register" i], a[href*="uaepass" i]'
      ) as HTMLAnchorElement | null;
      return a && a.href && !a.href.startsWith('javascript:') ? a.href : null;
    });

    let onLoginPage = false;
    if (loginHref) {
      try { await navigateAndWait(page, loginHref, { waitAfter: 3000 }); onLoginPage = true; } catch { /* */ }
    } else {
      const CLICKERS = [
        'button:has-text("Sign in")', 'button:has-text("Log in")', 'button:has-text("تسجيل الدخول")',
        '[aria-label*="sign in" i]', '[aria-label*="log in" i]', 'button[class*="login" i]', 'button[class*="signin" i]',
      ];
      for (const sel of CLICKERS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) {
          try {
            await loc.click({ timeout: 3000 });
            await page.waitForTimeout(3000);
            try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
            onLoginPage = true;
            break;
          } catch { /* try next */ }
        }
      }
    }
    await dismissCookieBanner(page);

    // Security signals on the login surface
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
    });
    const loginHost = hostOf(page.url());
    const viaUaePassDomain = loginHost.includes('uaepass');

    const ss = ssPath(auditJobId, '36');
    await takeHighlightedScreenshot(page, ss.abs, [
      'a[href*="uaepass" i]', 'button[class*="uaepass" i]', '[class*="uaepass" i]', 'img[alt*="uae pass" i]',
      'form input[type="password"]', 'input[type="password"]', 'form[action*="login" i]',
      'button:has-text("Sign in")', 'button:has-text("تسجيل الدخول")',
    ], {
      contextualZoom: true,
      label: 'Secure Login',
      maxHighlightBox: { width: 600, height: 300 },
    });

    // Restore the homepage for later pillars
    try { await navigateAndWait(page, url, { waitAfter: 2000 }); await dismissCookieBanner(page); } catch { /* */ }

    const signals: string[] = [];
    signals.push(`HTTPS: ${sec.isHttps ? 'Yes' : 'NO'}`);
    if (sec.hasUaePass || viaUaePassDomain) signals.push('UAE Pass federated login (secure digital identity)');
    if (sec.passwordFields > 0) signals.push(`${sec.passwordFields} masked password field(s)`);
    if (sec.unmaskedPwd > 0) signals.push(`${sec.unmaskedPwd} UNMASKED password field(s)`);
    if (!onLoginPage) signals.push('login page not reached — evaluated on the homepage');

    const secure =
      sec.isHttps &&
      sec.unmaskedPwd === 0 &&
      (sec.hasUaePass || viaUaePassDomain || sec.passwordFields > 0 || onLoginPage);

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
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, previousResults } = params;
  const results: CriterionResult[] = [];

  await dismissCookieBanner(page);

  const q35_1 = await checkQ35_1(page, url, auditJobId);
  results.push(q35_1.result);
  results.push(buildQ35(auditJobId, q35_1.result.status === 'pass', q35_1.policy, q35_1.inFooterOrHeader));
  results.push(await checkQ36(page, url, auditJobId, previousResults));

  return results;
}
