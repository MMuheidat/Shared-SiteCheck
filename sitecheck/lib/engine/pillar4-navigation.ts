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
import {
  navigateAndWait, takeHighlightedScreenshot, takeMultiHighlightScreenshot,
  dismissCookieBanner, openNavMenu, humanNavigate,
} from '@/lib/engine/helpers';
import { clickWithHighlight, humanScrollVerify, type EvidenceRecorder } from '@/lib/engine/recording';

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

function ssPath(auditJobId: string, name: string, suffix = '') {
  const fileName = `q${name}${suffix}.png`;
  return {
    rel: `/screenshots/${auditJobId}/${fileName}`,
    abs: path.join(process.cwd(), 'public', 'screenshots', auditJobId, fileName),
  };
}

// Terminal progress log — the evaluator watches the dev-server output to see
// where the engine currently is during a multi-minute recorded run.
function dbg(msg: string): void {
  console.log(`[SiteCheck][P4] ${msg}`);
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
//  ALL found links are highlighted together and ALL are verified — the full
//  2 points require every link to actually reach its platform. On recorded
//  runs each platform is visited on camera; otherwise background tabs are used.
// ────────────────────────────────────────────────────────────
const SOCIAL_DOMAINS = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'linkedin.com', 'youtube.com', 'tiktok.com', 'snapchat.com',
  'pinterest.com', 'whatsapp.com', 'wa.me', 't.me',
  'threads.net', 'threads.com',
];
const SOCIAL_CORES = [
  'twitter', 'x.com', 'facebook', 'instagram', 'linkedin',
  'youtube', 'tiktok', 'snapchat', 'pinterest', 'whatsapp', 'wa.me', 't.me',
  'threads',
];
// Share widgets ("share this page on X") are not the entity's own profiles.
const SOCIAL_SHARE_RX = /sharer|share-?article|\/share(\?|$|\/)|intent\/(tweet|post)|\/dialog\//i;
const MAX_SOCIAL_VISITS = 6;

// Login walls still count as functional: Instagram's /accounts/login,
// LinkedIn's /authwall and YouTube's consent screen all keep the platform
// core in the final URL, so this predicate passes them — the link did reach
// its platform, which is what a human verifies.
function landedOnSocial(finalUrl: string): boolean {
  return SOCIAL_CORES.some(core => finalUrl.toLowerCase().includes(core));
}

// A link that reaches the right platform host can still be BROKEN — a deleted
// profile / removed post keeps the platform core in the URL but renders an
// error page ("Sorry, this page isn't available"). Detect those by body text
// so they count as broken even though landedOnSocial() is true. Login/consent
// walls are intentionally NOT matched here (they are treated as reachable).
const SOCIAL_ERROR_RX =
  /(this (?:page|content|account|video) (?:isn'?t|is not|no longer) (?:available|active|exist)|sorry, (?:this|the) page|page not found|content not found|couldn'?t find this page|page (?:doesn'?t|does not) exist|this account (?:doesn'?t|does not) exist|user not found|video (?:isn'?t available|unavailable)|404 not found)/i;

async function socialPageHasError(p: Page): Promise<boolean> {
  return p
    .evaluate((rxSrc: string) => {
      const rx = new RegExp(rxSrc, 'i');
      const text = (document.body?.innerText || '').slice(0, 4000);
      return rx.test(text);
    }, SOCIAL_ERROR_RX.source)
    .catch(() => false);
}

/**
 * Find the entity's social profile links (host-matched, share widgets
 * excluded) and tag every matching anchor with data-sitecheck-social so the
 * evidence shot can outline them all. Returns one representative per platform.
 */
async function collectSocialLinks(page: Page): Promise<{ platform: string; href: string }[]> {
  return page.evaluate(
    (args: { domains: string[]; shareRx: string }) => {
      const shareRe = new RegExp(args.shareRx, 'i');
      const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const found: { platform: string; href: string }[] = [];
      for (const a of anchors) {
        let host = '';
        try { host = new URL(a.href).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
        const domain = args.domains.find(d => host === d || host.endsWith('.' + d));
        if (!domain || shareRe.test(a.href)) continue;
        a.setAttribute('data-sitecheck-social', domain);
        if (!found.some(f => f.platform === domain)) found.push({ platform: domain, href: a.href });
      }
      return found;
    },
    { domains: SOCIAL_DOMAINS, shareRx: SOCIAL_SHARE_RX.source },
  ).catch(() => []);
}

async function checkQ12(
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  const ss = ssPath(auditJobId, '12');
  try {
    await recorder?.setCaption("Q12 — Locating the entity's social media links…");

    let found = await collectSocialLinks(page);
    let usedBurger = false;
    // Social links sometimes hide behind the hamburger/3-dash menu. They can
    // also EXIST in the DOM while sitting off-canvas inside the closed drawer
    // (e.g. ADMO renders them at negative x) — treat that the same as absent
    // and open the menu so they become visible and clickable.
    const anySocialOnCanvas = () => page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-sitecheck-social]'))) {
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1 && r.right > 0 && r.left < window.innerWidth) return true;
      }
      return false;
    }).catch(() => false);
    if (found.length === 0 || !(await anySocialOnCanvas())) {
      await recorder?.setCaption('Q12 — Looking for social links in the navigation menu…');
      usedBurger = await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
      if (usedBurger) found = await collectSocialLinks(page);
    }

    if (found.length === 0) {
      if (usedBurger) { try { await page.keyboard.press('Escape'); } catch { /* */ } }
      if (recorder) {
        await recorder.setCaption('Q12 — No social media links found on this website');
        await page.waitForTimeout(1200);
      }
      await viewportShot(page, ss.abs);
      const stampNote = recorder ? ` [${recorder.stamp()}]` : '';
      return makeResult('Q12', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: `No social media links found on the page (navigation menu searched too).${stampNote}`,
      });
    }

    // Evidence: outline ALL of the social links together before any clicking.
    // Don't cluster-scroll when the links live in the opened drawer — they are
    // already in view, and scrolling closes some drawers (e.g. ADMO's).
    await takeMultiHighlightScreenshot(page, ss.abs, [
      { selector: '[data-sitecheck-social]', label: 'Social Media Links' },
    ], {
      holdMs: recorder ? 1200 : 400,
      maxBox: { width: 400, height: 150 },
      scrollToCluster: !usedBurger,
    });
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-sitecheck-social]'))) {
        el.removeAttribute('data-sitecheck-social');
      }
    }).catch(() => { /* evidence only */ });

    const toVisit = found.slice(0, MAX_SOCIAL_VISITS);
    const capNote = found.length > toVisit.length
      ? ` ${found.length - toVisit.length} more platform(s) found but not visited (capped at ${MAX_SOCIAL_VISITS}).`
      : '';
    const burgerNote = usedBurger ? ' Links found inside the navigation menu.' : '';
    dbg(`Q12: found ${found.length} social platform(s) (${found.map(f => f.platform).join(', ')})${usedBurger ? ' via the navigation menu' : ''} — verifying ${toVisit.length}${recorder ? ' on camera' : ''}`);

    let working = 0;
    const testResults: string[] = [];
    const brokenReasons: string[] = [];

    if (recorder) {
      // On-camera journey: click each link, scroll its page like a human, return.
      let navigatedAway = false;
      for (const link of toVisit) {
        await recorder.setCaption(`Q12 — Opening ${link.platform}…`);
        dbg(`Q12: opening ${link.platform}…`);
        let finalUrl = '';
        let httpErrored = false;
        try {
          // isVisible() is true for off-canvas drawer links — require real
          // on-canvas coordinates before trying to click like a human, and
          // prefer an on-canvas duplicate (footer icon) over an off-canvas
          // one (closed-drawer copy) when the same link appears twice.
          const vpWidth = page.viewportSize()?.width ?? 1280;
          const boxOk = async (loc: ReturnType<typeof page.locator>) => {
            const b = await loc.boundingBox().catch(() => null);
            return !!b && b.width > 1 && b.height > 1 && b.x + b.width > 0 && b.x < vpWidth;
          };
          const pickAnchor = async () => {
            for (const sel of [`a[href="${link.href}"]`, `a[href*="${link.platform}"]`]) {
              const candidates = await page.locator(sel).all().catch(() => []);
              for (const cand of candidates.slice(0, 8)) {
                if (await boxOk(cand)) return cand;
              }
              if (candidates.length > 0) return candidates[0];
            }
            return page.locator(`a[href*="${link.platform}"]`).first();
          };
          let anchor = await pickAnchor();
          const clickableBox = () => boxOk(anchor);
          if (!(await clickableBox()) && usedBurger) {
            await openNavMenu(page, { holdMs: 1000 });
            anchor = await pickAnchor();
          }

          // Some icons window.open regardless of target — catch stray popups.
          let popup: Page | null = null;
          const popupHandler = (p: Page) => { popup = p; };
          page.context().once('page', popupHandler);

          if (await clickableBox()) {
            try {
              await anchor.scrollIntoViewIfNeeded().catch(() => {});
              // Force same-tab so the visit appears in the recorded page's video.
              await anchor.evaluate(el => { (el as HTMLAnchorElement).target = '_self'; }).catch(() => {});
              await clickWithHighlight(anchor, { holdMs: 1000, timeout: 5000 });
              await page.waitForURL(u => landedOnSocial(u.href), { timeout: 15000, waitUntil: 'domcontentloaded' })
                .catch(() => { /* judged below */ });
            } catch {
              dbg(`Q12: ${link.platform} click failed — falling back to direct goto`);
            }
          }

          if (landedOnSocial(page.url())) {
            finalUrl = page.url();
            navigatedAway = true;
          } else if (popup) {
            const p = popup as Page;
            await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            finalUrl = p.url();
            await p.close().catch(() => {});
            // Replay the visit on the recorded page so it lands on video.
            const rr = await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
            if (rr && rr.status() >= 400) httpErrored = true;
            navigatedAway = true;
            if (!landedOnSocial(finalUrl)) finalUrl = page.url();
          } else {
            // Click didn't take us anywhere (or anchor unclickable) — go directly.
            const rr = await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
            if (rr && rr.status() >= 400) httpErrored = true;
            finalUrl = page.url();
            navigatedAway = true;
          }
          page.context().off('page', popupHandler);

          await page.waitForTimeout(1500);
          const landed = landedOnSocial(finalUrl) || landedOnSocial(page.url());
          const errorPage = landed && !httpErrored ? await socialPageHasError(page) : false;
          if (landed && !httpErrored && !errorPage) {
            working++;
            testResults.push(`${link.platform} ✓`);
            dbg(`Q12: ${link.platform} ✓`);
            await recorder.setCaption(`Q12 — ${link.platform} opened ✓ — verifying the page…`);
            await humanScrollVerify(page, { maxSteps: 2, delayMs: 300 });
          } else {
            const reason = !landed
              ? `redirected off-platform (${finalUrl.slice(0, 60)})`
              : httpErrored
                ? 'server returned an error (HTTP ≥ 400)'
                : 'platform error / page-not-found';
            brokenReasons.push(`${link.platform}: ${reason}`);
            testResults.push(`${link.platform} ✗ (${reason})`);
            dbg(`Q12: ${link.platform} ✗ (${reason})`);
            await recorder.setCaption(`Q12 — ${link.platform} did not open correctly ✗`);
            await page.waitForTimeout(1200);
          }
        } catch {
          brokenReasons.push(`${link.platform}: failed to load`);
          testResults.push(`${link.platform} ✗ (failed to load)`);
          dbg(`Q12: ${link.platform} ✗ (failed to load)`);
        }
        if (navigatedAway) {
          await recorder.setCaption('Q12 — Returning to the entity website…');
          dbg('Q12: returning to homepage');
          // goBack is fast and looks human; fall back to a full navigation
          // only when history doesn't land us back on the entity site.
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(800);
          if (!page.url().startsWith(new URL(url).origin)) {
            await navigateAndWait(page, url, { waitAfter: 1000 });
          }
          navigatedAway = false;
        }
      }
    } else {
      // Fast path: verify every link in background tabs (same predicate).
      for (const link of toVisit) {
        const socialPage = await page.context().newPage();
        try {
          const rr = await socialPage.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await socialPage.waitForTimeout(1500);
          const landed = landedOnSocial(socialPage.url());
          const httpErrored = !!rr && rr.status() >= 400;
          const errorPage = landed && !httpErrored ? await socialPageHasError(socialPage) : false;
          if (landed && !httpErrored && !errorPage) {
            working++;
            testResults.push(`${link.platform} ✓`);
          } else {
            const reason = !landed
              ? `redirected to ${socialPage.url().slice(0, 60)}`
              : httpErrored
                ? 'server returned an error (HTTP ≥ 400)'
                : 'platform error / page-not-found';
            brokenReasons.push(`${link.platform}: ${reason}`);
            testResults.push(`${link.platform} ✗ (${reason})`);
          }
        } catch {
          brokenReasons.push(`${link.platform}: failed to load`);
          testResults.push(`${link.platform} ✗ (failed to load)`);
        } finally {
          await socialPage.close().catch(() => null);
        }
      }
    }

    const tested = toVisit.length;
    const broken = tested - working;
    const platforms = found.map(d => d.platform).join(', ');
    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';
    const brokenNote = brokenReasons.length ? ` Broken: ${brokenReasons.join('; ')}.` : '';

    // 3-tier scoring: all links working → 2/2; exactly one broken → 1/2;
    // more than one broken → 0/2 fail.
    if (broken === 0) {
      return makeResult('Q12', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Social media links available and functional — all ${tested} verified. Platforms: ${platforms}.${capNote}${burgerNote} Tested: ${testResults.join(', ')}.${stampNote}`,
        recommendation: '',
      });
    }
    if (broken === 1) {
      return makeResult('Q12', {
        scoreEarned: 1,
        status: 'partial',
        screenshotPath: ss.rel,
        notes: `Social media links present but 1 of ${tested} did not work.${brokenNote} Platforms: ${platforms}.${capNote}${burgerNote} Tested: ${testResults.join(', ')}.${stampNote}`,
        recommendation: 'Fix or remove the broken social media link so every listed profile is reachable.',
      });
    }
    return makeResult('Q12', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Social media links present but ${broken} of ${tested} did not work (more than one broken).${brokenNote} Platforms: ${platforms}.${capNote}${burgerNote} Tested: ${testResults.join(', ')}.${stampNote}`,
      recommendation: 'Fix or remove the broken social media links so every listed profile is reachable.',
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
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<{ result: CriterionResult; hasSearch: boolean }> {
  try {
    await recorder?.setCaption('Q13 — Locating the search bar on the homepage…');
    const onHomepage = await detectSearchOnPage(page);
    dbg(`Q13: homepage search bar ${onHomepage ? 'found' : 'NOT found'}`);

    const ss = ssPath(auditJobId, '13');
    await takeHighlightedScreenshot(page, ss.abs, SEARCH_EVIDENCE_SELECTORS, {
      contextualZoom: true,
      label: 'Search Bar',
      maxHighlightBox: { width: 700, height: 120 },
    });

    // Check internal pages for the same search control.
    // Login/authentication pages (UAE Pass etc.) are excluded — they are
    // exceptional pages not expected to carry the search bar.
    let candidateLinks = (await discoverInternalLinks(page, url, 10))
      .filter(l => !LOGIN_PAGE_RX.test(l));
    if (candidateLinks.length < 2) {
      // Sparse landing pages keep their navigation behind the burger menu.
      await recorder?.setCaption('Q13 — Opening the navigation menu to find pages…');
      if (await openNavMenu(page, { holdMs: recorder ? 1000 : 100 })) {
        candidateLinks = (await discoverInternalLinks(page, url, 10))
          .filter(l => !LOGIN_PAGE_RX.test(l));
      }
    }
    const internalLinks = candidateLinks.slice(0, 4);
    const stripSlash = (u: string) => u.replace(/\/+$/, '');
    let pageIdx = 0;
    let pagesChecked = 0;
    let pagesWithSearch = 0;
    let loginPagesSkipped = 0;
    const missingOn: string[] = [];
    for (const link of internalLinks) {
      try {
        pageIdx++;
        if (recorder) {
          // Navigate like a human: back to the homepage, then click the link.
          if (stripSlash(page.url()) !== stripSlash(url)) {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(800);
            if (stripSlash(page.url()) !== stripSlash(url)) {
              await navigateAndWait(page, url, { waitAfter: 1000 });
            }
          }
          await recorder.setCaption(`Q13 — Visiting an internal page (${pageIdx} of ${internalLinks.length}) to check the search bar…`);
          dbg(`Q13: visiting internal page ${pageIdx}/${internalLinks.length}: ${link}`);
          await humanNavigate(page, link, recorder);
        } else {
          await navigateAndWait(page, link, { waitAfter: 2000 });
        }

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
            const pwd = !!document.querySelector('input[type="password"]');
            if (pwd) return true;
            const sparse = body.length < 4000;
            const uaePass = body.toLowerCase().includes('uae pass') || body.includes('الهوية الرقمية');
            const signInText = /\b(sign in|log in|login)\b/i.test(body.slice(0, 2000));
            // A dedicated login page is sparse AND has almost no navigation.
            // Visually-rich content pages (e.g. TAMM's) can carry little text
            // but keep the site's header/footer link mass — and every page has
            // a "Sign in" header button, so text signals alone false-positive.
            const anchorCount = document.querySelectorAll('a[href]').length;
            return sparse && anchorCount < 15 && (uaePass || signInText);
          });
        }
        if (isLogin) {
          loginPagesSkipped++;
          dbg('Q13: login page reached — excluded as exceptional');
          if (recorder) {
            await recorder.setCaption('Q13 — Login page reached — excluded as exceptional');
            await page.waitForTimeout(1200);
          }
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

        if (recorder) {
          // Show the verdict for this page on camera (extra frames exist on
          // disk as q13_pageN.png; only q13.png is referenced in the DB).
          const pageShot = ssPath(auditJobId, '13', `_page${pageIdx}`);
          if (hasSearch) {
            dbg('Q13: search bar present on this page ✓');
            await recorder.setCaption('Q13 — Search bar present on this page ✓');
            await takeMultiHighlightScreenshot(
              page, pageShot.abs,
              SEARCH_EVIDENCE_SELECTORS.map(s => ({ selector: s })),
              { holdMs: 1200, maxTotal: 2, maxBox: { width: 700, height: 120 } },
            );
          } else {
            dbg('Q13: no search bar found on this page ✗');
            await recorder.setCaption('Q13 — No search bar found on this page');
            await page.waitForTimeout(1200);
            await viewportShot(page, pageShot.abs);
          }
        }
      } catch { /* skip */ }
    }
    if (pagesChecked > 0 || loginPagesSkipped > 0) await navigateAndWait(page, url);
    const loginNote = loginPagesSkipped > 0 ? ` (${loginPagesSkipped} login page(s) excluded as exceptional)` : '';
    const missingNote = missingOn.length > 0 ? ` Missing on: ${missingOn.join(', ')}.` : '';
    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';

    if (!onHomepage) {
      const result = makeResult('Q13', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: `No search bar found on the homepage. Internal pages with search: ${pagesWithSearch}/${pagesChecked}.${stampNote}`,
      });
      return { result, hasSearch: false };
    }

    if (pagesChecked === 0 || pagesWithSearch === pagesChecked) {
      const result = makeResult('Q13', {
        scoreEarned: 2,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: pagesChecked === 0
          ? `Search bar found on the homepage; no internal pages could be checked (treated as consistent).${loginNote}${stampNote}`
          : `Search bar accessible on all checked pages (homepage + ${pagesChecked} internal).${loginNote}${stampNote}`,
        recommendation: '',
      });
      return { result, hasSearch: true };
    }

    const result = makeResult('Q13', {
      scoreEarned: 1,
      status: 'partial',
      screenshotPath: ss.rel,
      notes: `Search bar available on the homepage but missing on ${pagesChecked - pagesWithSearch} of ${pagesChecked} internal pages checked.${missingNote}${loginNote}${stampNote}`,
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
// Tag the actual phone / email / address elements (smallest visible match)
// with data-sitecheck-contact so the evidence shot outlines the details
// themselves rather than a generic contact container. Evidence-only.
async function markContactElements(page: Page): Promise<number> {
  return page.evaluate(() => {
    const firstVisible = (sel: string): Element | null => {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) return el;
      }
      return els[0] ?? null;
    };
    const smallestMatching = (test: (text: string) => boolean): Element | null => {
      const candidates = document.querySelectorAll(
        'footer *, [class*="contact"] *, [id*="contact"] *, address, p, li, span, a, td, div',
      );
      let best: Element | null = null;
      let bestArea = Infinity;
      for (const el of Array.from(candidates)) {
        const text = ((el as HTMLElement).innerText || '').trim();
        if (!text || text.length > 200 || !test(text)) continue;
        const r = el.getBoundingClientRect();
        // Details often sit in full-width paragraphs (e.g. ADMO's contact
        // page, 903px wide) — allow wide blocks, just not whole-page containers.
        if (r.width < 2 || r.height < 2 || r.width > 1000 || r.height > 250) continue;
        const area = r.width * r.height;
        if (area < bestArea) { best = el; bestArea = area; }
      }
      return best;
    };
    const tag = (el: Element | null, kind: string): number => {
      if (!el) return 0;
      (el as HTMLElement).setAttribute('data-sitecheck-contact', kind);
      return 1;
    };
    let tagged = 0;
    tagged += tag(
      firstVisible('a[href^="tel:"]') ?? smallestMatching(t => /(\+?\d[\d\-\s()]{7,}\d)/.test(t)),
      'phone',
    );
    tagged += tag(
      firstVisible('a[href^="mailto:"]') ?? smallestMatching(t => /[\w.-]+@[\w.-]+\.\w{2,}/.test(t)),
      'email',
    );
    tagged += tag(
      firstVisible(
        'address, iframe[src*="maps"], a[href*="google.com/maps"], a[href*="maps.app.goo.gl"], a[href*="goo.gl/maps"]',
      ) ?? smallestMatching(t => {
        const lower = t.toLowerCase();
        return lower.includes('address') || lower.includes('عنوان') ||
          lower.includes('p.o. box') || lower.includes('ص.ب');
      }),
      'address',
    );
    return tagged;
  }).catch(() => 0);
}

async function checkQ16(
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
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

    await recorder?.setCaption('Q16 — Checking the website for contact details…');
    dbg('Q16: scanning the homepage for contact details…');
    const home = await page.evaluate(detectContactDetails);
    const homeHasAll = home.hasPhone && home.hasEmail && home.hasAddressOrMap;

    // Follow the contact page if one is linked — details often live there.
    // Contact/support pages are found by href, by link text, and (both modes,
    // so grading stays identical) behind the burger menu as a last resort.
    const findContactHref = () => page.evaluate(() => {
      const byHref = document.querySelector(
        'a[href*="contact" i], a[href*="اتصل"], a[href*="تواصل"]'
      ) as HTMLAnchorElement | null;
      if (byHref) return byHref.href;
      const re = /contact|support|تواصل|اتصل|الدعم/i;
      const scoped = Array.from(
        document.querySelectorAll('header a, nav a, footer a'),
      ) as HTMLAnchorElement[];
      const byText = scoped.find(a => re.test((a.textContent || '').trim()));
      return byText ? byText.href : null;
    }).catch(() => null);

    let contactHref = await findContactHref();
    let usedBurger = false;
    if (!contactHref && !homeHasAll) {
      await recorder?.setCaption('Q16 — Looking for a Contact page in the navigation menu…');
      usedBurger = await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
      if (usedBurger) contactHref = await findContactHref();
      if (usedBurger && !contactHref) { try { await page.keyboard.press('Escape'); } catch { /* */ } }
    }

    let contactPage = { hasPhone: false, hasEmail: false, hasAddressOrMap: false };
    let contactPageChecked = false;
    let onContactPage = false;
    if (contactHref && !homeHasAll) {
      if (recorder) {
        // Visit the contact page on camera — the journey is the evidence.
        // humanNavigate clicks the on-page anchor when clickable (reopening
        // the burger for drawer links) and falls back to a direct goto.
        try {
          await recorder.setCaption('Q16 — Opening the Contact page…');
          dbg(`Q16: opening contact page ${contactHref}`);
          await humanNavigate(page, contactHref, recorder);
          await dismissCookieBanner(page);
          contactPage = await page.evaluate(detectContactDetails);
          contactPageChecked = true;
          onContactPage = true;
          await recorder.setCaption('Q16 — Reviewing the contact information on this page…');
          await humanScrollVerify(page, { maxSteps: 4 });
        } catch {
          dbg('Q16: on-camera contact page visit failed');
        }
      } else {
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
    }

    const hasPhone = home.hasPhone || contactPage.hasPhone;
    const hasEmail = home.hasEmail || contactPage.hasEmail;
    const hasAddressOrMap = home.hasAddressOrMap || contactPage.hasAddressOrMap;
    const detailCount = [hasPhone, hasEmail, hasAddressOrMap].filter(Boolean).length;
    dbg(`Q16: details found — phone ${hasPhone ? '✓' : '✗'} email ${hasEmail ? '✓' : '✗'} address ${hasAddressOrMap ? '✓' : '✗'}`);

    // Evidence: outline the phone / email / address elements themselves on
    // whichever page we are on (contact page when visited on camera).
    const ss = ssPath(auditJobId, '16');
    const marked = await markContactElements(page);
    if (marked > 0) {
      await recorder?.setCaption('Q16 — Highlighting the phone, email and address details…');
      await takeMultiHighlightScreenshot(page, ss.abs, [
        { selector: '[data-sitecheck-contact="phone"]', label: 'Phone' },
        { selector: '[data-sitecheck-contact="email"]', label: 'Email' },
        { selector: '[data-sitecheck-contact="address"]', label: 'Address / Map' },
      ], {
        holdMs: recorder ? 1200 : 400,
        maxBox: { width: 1000, height: 260 },
      });
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('[data-sitecheck-contact]'))) {
          el.removeAttribute('data-sitecheck-contact');
        }
      }).catch(() => { /* evidence only */ });
    } else {
      // Nothing markable — fall back to the container-level highlight so the
      // evidence shot is never blank.
      await takeHighlightedScreenshot(page, ss.abs, [
        'address', '[class*="contact"]', '[id*="contact"]',
        'a[href^="tel:"]', 'a[href^="mailto:"]',
        'a[href*="contact" i]', 'a[href*="اتصل"]', 'a[href*="تواصل"]',
        'iframe[src*="maps"]', 'footer',
      ], {
        contextualZoom: true,
        label: 'Contact Information',
      });
    }

    if (onContactPage) {
      dbg('Q16: restoring homepage');
      await navigateAndWait(page, url, { waitAfter: 1500 });
      await dismissCookieBanner(page);
    }

    const details = [
      hasPhone ? 'Phone ✓' : 'Phone ✗',
      hasEmail ? 'Email ✓' : 'Email ✗',
      hasAddressOrMap ? 'Address/Map ✓' : 'Address/Map ✗',
    ].join(', ');
    const burgerNote = usedBurger ? ' Contact page found via the navigation menu.' : '';
    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';
    const source = (contactPageChecked ? ' (homepage + contact page checked)' : ' (homepage checked)') +
      burgerNote + stampNote;

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

// ────────────────────────────────────────────────────────────
//  Q17 + Q17.1 run as ONE continuous journey (recorded on camera):
//  locate the feedback option → highlight WHERE it sits (q17_1.png) →
//  click it and let the actual form/modal open (q17.png shows the FORM).
//  Q17.1 (easy to find + complete) depends on Q17 passing.
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

async function runFeedbackJourney(
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<{ q17: CriterionResult; q17_1: CriterionResult }> {
  const ss17 = ssPath(auditJobId, '17');
  const ss171 = ssPath(auditJobId, '17_1');
  const stampNote = () => (recorder ? ` [${recorder.stamp()}]` : '');

  // ---- Q17: is a feedback/survey option available at all?
  let q17: CriterionResult;
  let q17Passed = false;
  try {
    await recorder?.setCaption('Q17 — Looking for a feedback or survey option…');
    dbg('Q17: scanning for feedback/survey elements…');
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
    q17Passed = found.elements > 0 || found.hasFeedbackText;
    dbg(`Q17: elements=${found.elements}, feedback text=${found.hasFeedbackText ? 'yes' : 'no'} → ${q17Passed ? 'available' : 'not found'}`);
    q17 = makeResult('Q17', {
      scoreEarned: q17Passed ? 1 : 0,
      status: q17Passed ? 'pass' : 'fail',
      screenshotPath: ss17.rel,
      notes: `Feedback elements: ${found.elements}. Feedback-related text: ${found.hasFeedbackText ? 'Yes' : 'No'}.${stampNote()}`,
      recommendation: q17Passed ? '' : getRecommendation('Q17'),
    });
  } catch (err: unknown) {
    q17 = makeResult('Q17', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }

  if (!q17Passed) {
    if (recorder) {
      await recorder.setCaption('Q17 — No feedback or survey option found on this website');
      await page.waitForTimeout(1200);
    }
    await viewportShot(page, ss17.abs).catch(() => {});
    return {
      q17,
      q17_1: makeResult('Q17.1', { status: 'skipped', notes: 'Skipped — Q17 did not pass.' }),
    };
  }

  // ---- Q17.1: where the option sits (q17_1.png) + open the actual form (q17.png)
  let q17_1: CriterionResult;
  let navigatedAway = false;
  let modalOpened = false;
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
    dbg(`Q17.1: feedback option ${findability.how}`);

    // q17_1.png = WHERE the feedback option lives, before any navigation.
    await recorder?.setCaption(`Q17.1 — Feedback option located (${findability.how})`);
    await takeHighlightedScreenshot(page, ss171.abs, FEEDBACK_SELECTORS, {
      contextualZoom: true,
      label: 'Feedback Link',
      maxHighlightBox: { width: 500, height: 200 },
    });

    const feedbackHref = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll(
        'a[href*="feedback" i], a[href*="survey" i], a[href*="satisfaction" i]'
      )) as HTMLAnchorElement[];
      const kwRe = /feedback|survey|satisfaction|ملاحظات|تقييم|استبيان|رأيك/i;
      // Prefer a link whose visible TEXT says feedback/survey — href-substring
      // matches alone can hit news articles ("…mapping survey across…").
      const byText = anchors.find(a => kwRe.test((a.textContent || '').trim()));
      if (byText) return byText.href;
      const plausible = anchors.find(a => {
        try {
          const u = new URL(a.href);
          const segs = u.pathname.split('/').filter(Boolean);
          const last = segs[segs.length - 1] || '';
          // Article URLs are deep and carry long slugs — a real feedback
          // page is shallow (/feedback, /ar/survey, …).
          return segs.length <= 3 && last.length <= 40;
        } catch { return false; }
      });
      return plausible ? plausible.href : null;
    });

    let formInfo = { formFields: 0, hasEmbed: false, hasRatingUI: false, hasSurveyDialog: false, checked: false };
    let evidenceCaptured = false;
    let openMethod = '';

    if (feedbackHref && recorder) {
      // On camera: click the feedback link and let the form open on the
      // recorded page (q17.png shows the ACTUAL form/modal).
      try {
        await recorder.setCaption('Q17 — Opening the feedback form…');
        dbg(`Q17: opening feedback form on camera: ${feedbackHref}`);
        const u = new URL(feedbackHref);
        const anchor = page
          .locator(`a[href="${feedbackHref}"], a[href="${u.pathname + u.search}"]`)
          .first();
        if (await anchor.isVisible().catch(() => false)) {
          await anchor.evaluate(el => { (el as HTMLAnchorElement).target = '_self'; }).catch(() => {});
          await anchor.scrollIntoViewIfNeeded().catch(() => {});
          await clickWithHighlight(anchor, { holdMs: 1000, timeout: 5000 });
          try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* */ }
        } else {
          await navigateAndWait(page, feedbackHref);
        }
        // Survey modals (e.g. TAMM's "Rate Your Experience") open after a delay
        await page.waitForTimeout(4000);
        await dismissCookieBanner(page);
        navigatedAway = true;
        formInfo = { ...(await page.evaluate(inspectFeedbackForm)), checked: true };
        await recorder.setCaption('Q17 — Feedback form opened — reviewing it…');
        await viewportShot(page, ss17.abs);
        evidenceCaptured = true;
        openMethod = 'opened via feedback link';
        dbg(`Q17: form opened — ${formInfo.formFields} fields${formInfo.hasRatingUI ? ', rating widget' : ''}${formInfo.hasSurveyDialog ? ', survey dialog' : ''}`);
        await humanScrollVerify(page, { maxSteps: 2, delayMs: 300 });
      } catch {
        dbg('Q17: on-camera form open failed — falling back');
      }
    } else if (feedbackHref) {
      // Fast path (non-recorded): inspect the form in a background tab.
      const fp = await page.context().newPage();
      try {
        await fp.goto(feedbackHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await fp.waitForTimeout(4000);
        await dismissCookieBanner(fp);
        await fp.waitForTimeout(500);
        formInfo = { ...(await fp.evaluate(inspectFeedbackForm)), checked: true };
        await viewportShot(fp, ss17.abs);
        evidenceCaptured = true;
        openMethod = 'opened via feedback link';
      } catch { /* fall through to click path */ } finally {
        await fp.close().catch(() => null);
      }
    }

    // Fallback: no link (or the link path failed) — click the in-page
    // feedback control to open its widget/modal on the current page.
    if (!evidenceCaptured) {
      const urlBefore = page.url();
      // Pick a PLAUSIBLE control only: a widget element, or an anchor whose
      // text says feedback/survey — bare href-substring anchors are often
      // news articles ("…mapping survey…") and must not be clicked.
      const hasCandidate = await page.evaluate(() => {
        const kwRe = /feedback|survey|satisfaction|ملاحظات|تقييم|استبيان|رأيك/i;
        const sels = [
          'a[href*="feedback" i]', 'a[href*="survey" i]', 'a[href*="satisfaction" i]',
          '[class*="feedback"]', '[id*="feedback"]', '[class*="survey"]', '[id*="survey"]',
        ];
        for (const sel of sels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            if (el.tagName === 'A') {
              const a = el as HTMLAnchorElement;
              if (!kwRe.test((a.textContent || '').trim())) {
                try {
                  const u = new URL(a.href);
                  const segs = u.pathname.split('/').filter(Boolean);
                  const last = segs[segs.length - 1] || '';
                  if (segs.length > 3 || last.length > 40) continue; // article-like URL
                } catch { continue; }
              }
            }
            el.setAttribute('data-sitecheck-fbctl', '1');
            return true;
          }
        }
        return false;
      }).catch(() => false);

      let clicked = false;
      if (hasCandidate) {
        const loc = page.locator('[data-sitecheck-fbctl]').first();
        try {
          await recorder?.setCaption('Q17 — Opening the feedback option…');
          dbg('Q17: clicking in-page feedback control…');
          if (recorder) await clickWithHighlight(loc, { holdMs: 1000, timeout: 2000 });
          else await loc.click({ timeout: 2000 });
          clicked = true;
          modalOpened = true;
          await page.waitForTimeout(2500);
        } catch {
          dbg('Q17: in-page feedback control not clickable');
        }
        await page.evaluate(() => {
          for (const el of Array.from(document.querySelectorAll('[data-sitecheck-fbctl]'))) {
            el.removeAttribute('data-sitecheck-fbctl');
          }
        }).catch(() => { /* page may have navigated */ });
      }
      await dismissCookieBanner(page);
      await page.waitForTimeout(300);
      if (page.url() !== urlBefore) {
        // The control was a link after all — restore via navigation, not Escape.
        navigatedAway = true;
        modalOpened = false;
      }
      if (clicked) {
        formInfo = { ...(await page.evaluate(inspectFeedbackForm)), checked: true };
        openMethod = 'opened via in-page feedback control';
        await recorder?.setCaption('Q17 — Feedback form opened — reviewing it…');
      } else if (recorder) {
        dbg('Q17: no clickable feedback control found');
        await recorder.setCaption('Q17 — Feedback indicators found, but no feedback form could be opened');
        await page.waitForTimeout(1200);
      }
      await viewportShot(page, ss17.abs);
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
      q17_1 = makeResult('Q17.1', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: ss171.rel,
        notes: `Feedback is easy to find (${findability.how}) and complete.${formNote}${stampNote()}`,
        recommendation: '',
      });
    } else {
      q17_1 = makeResult('Q17.1', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss171.rel,
        notes: `Feedback found but not easy to find/complete — ${findability.how}.${formNote}${stampNote()}`,
      });
    }
  } catch (err: unknown) {
    q17_1 = makeResult('Q17.1', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Restore homepage state for the next checks (Q18 shoots the homepage).
  if (modalOpened) {
    try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch { /* */ }
  }
  if (navigatedAway) {
    dbg('Q17: restoring homepage');
    await navigateAndWait(page, url, { waitAfter: 1500 });
    await dismissCookieBanner(page);
  }

  return { q17, q17_1 };
}

// ────────────────────────────────────────────────────────────
//  Q18 — Clear Menu Labels [1/0]
// ────────────────────────────────────────────────────────────
async function checkQ18(
  page: Page, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  try {
    await recorder?.setCaption('Q18 — Reviewing the main menu categories…');

    // Open the burger drawer FIRST (both modes, so grading sees the real
    // menu): sites like ADMO keep the whole navigation behind it, and the
    // drawer markup often lives outside <nav>/<header> wrappers.
    let openedMenu = false;
    const visibleNavLinks = await page.evaluate(() => {
      let n = 0;
      for (const a of Array.from(document.querySelectorAll('nav a, header a, [role="navigation"] a, [role="menuitem"]'))) {
        const r = a.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight &&
            r.left >= 0 && r.right <= window.innerWidth) n++;
      }
      return n;
    }).catch(() => 0);
    if (visibleNavLinks < 3) {
      await recorder?.setCaption('Q18 — Navigation is behind a menu; opening it…');
      dbg('Q18: navigation hidden — opening the burger menu');
      openedMenu = await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
    }

    // Grade the menu labels and tag them for the evidence shot in one pass.
    // When nav-scoped selectors find almost nothing (drawer markup outside
    // <nav>/<header>), fall back to visible in-viewport internal links with
    // menu-length (≤50 chars) text.
    const data = await page.evaluate(() => {
      const toLabels = (els: Element[]) => els
        .map((el) => (el as HTMLElement).textContent?.trim() ?? '')
        .filter((t) => t.length > 0);

      let labelEls = Array.from(
        document.querySelectorAll('nav a, header a, [role="navigation"] a, [role="menuitem"]'),
      );
      let labels = toLabels(labelEls);
      if (labels.length < 3) {
        const orig = location.origin;
        const fallbackEls = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
          const href = (a as HTMLAnchorElement).href;
          if (!href.startsWith(orig)) return false;
          const text = (a as HTMLElement).textContent?.trim() ?? '';
          if (!text || text.length > 50) return false;
          const r = a.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && r.top >= 0 && r.top < window.innerHeight &&
            r.left >= 0 && r.right <= window.innerWidth;
        });
        const fallbackLabels = toLabels(fallbackEls);
        if (fallbackLabels.length > labels.length) {
          labelEls = fallbackEls;
          labels = fallbackLabels;
        }
      }

      const vagueTerms = [
        'miscellaneous', 'other', 'more', 'stuff', 'click here', 'link',
        'page', 'أخرى', 'متفرقات', 'المزيد',
      ];
      const vagueLabels = labels.filter((l) =>
        vagueTerms.some((vt) => l.toLowerCase() === vt),
      );
      const tooShort = labels.filter((l) => l.length === 1);
      const tooLong = labels.filter((l) => l.length > 50);

      // Tag up to 8 visible, uniquely-labeled items for the evidence shot.
      const seen = new Set<string>();
      let count = 0;
      for (const a of labelEls) {
        if (count >= 8) break;
        const text = (a as HTMLElement).textContent?.trim() ?? '';
        if (!text || seen.has(text.toLowerCase())) continue;
        const r = a.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= window.innerWidth ||
            r.bottom <= 0 || r.top >= window.innerHeight) continue;
        seen.add(text.toLowerCase());
        a.setAttribute('data-sitecheck-menuitem', '1');
        count++;
      }

      return {
        totalLabels: labels.length,
        vagueCount: vagueLabels.length,
        vagueLabels,
        tooShort: tooShort.length,
        tooLong: tooLong.length,
      };
    });

    const ss = ssPath(auditJobId, '18');
    await takeMultiHighlightScreenshot(page, ss.abs, [
      { selector: '[data-sitecheck-menuitem]', label: 'Menu Categories' },
    ], {
      holdMs: recorder ? 2000 : 400,
      maxBox: { width: 400, height: 100 },
    });
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-sitecheck-menuitem]'))) {
        el.removeAttribute('data-sitecheck-menuitem');
      }
    }).catch(() => { /* evidence only */ });
    if (openedMenu) {
      // Close the drawer so later checks' shots aren't covered by it.
      try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch { /* */ }
    }

    const passed =
      data.totalLabels > 0 &&
      data.vagueCount === 0 &&
      data.tooShort === 0 &&
      data.tooLong === 0;
    dbg(`Q18: ${data.totalLabels} menu labels (vague ${data.vagueCount}, short ${data.tooShort}, long ${data.tooLong}) → ${passed ? 'pass' : 'fail'}`);

    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';
    return makeResult('Q18', {
      scoreEarned: passed ? 1 : 0,
      status: data.totalLabels === 0 ? 'fail' : passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Menu items: ${data.totalLabels}. Vague labels: ${data.vagueCount}${data.vagueLabels.length ? ' (' + data.vagueLabels.join(', ') + ')' : ''}. Too short: ${data.tooShort}. Too long: ${data.tooLong}.${openedMenu ? ' Menu categories shown via the navigation drawer.' : ''}${stampNote}`,
      recommendation: passed ? '' : getRecommendation('Q18'),
    });
  } catch (err: unknown) {
    return makeResult('Q18', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q19 — Content Free from Jargon [1/0]
// ────────────────────────────────────────────────────────────
async function checkQ19(
  page: Page, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
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

    if (recorder) {
      // Review the content on camera the way a human reader would.
      // Homepage-only by design — Q13 already tours internal pages on this
      // pillar's video, so this keeps the recording bounded.
      await recorder.setCaption('Q19 — Scrolling through the page to review content for jargon and plain language…');
      dbg('Q19: scrolling through the page content');
      await humanScrollVerify(page, { maxSteps: 6 });
    }

    const ss = ssPath(auditJobId, '19');
    await viewportShot(page, ss.abs);

    const jargonRatio = data.wordCount > 0 ? data.jargonFound.length / data.wordCount : 0;
    const passed = data.jargonFound.length <= 2 && jargonRatio < 0.001;

    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';
    return makeResult('Q19', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Jargon terms found: ${data.jargonFound.length}${data.jargonFound.length ? ' (' + data.jargonFound.join(', ') + ')' : ''}. Total words: ${data.wordCount}.${stampNote}`,
      recommendation: passed ? '' : getRecommendation('Q19'),
    });
  } catch (err: unknown) {
    return makeResult('Q19', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q20 — Clear Buttons and Links [1/0]
// ────────────────────────────────────────────────────────────
async function checkQ20(
  page: Page, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
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

    // Evidence: outline representative clearly-labeled controls (prefer the
    // ones already in view — header/hero buttons) rather than a bare page shot.
    await page.evaluate(() => {
      const vague = ['click here', 'here', 'read more', 'more', 'link', 'اضغط هنا', 'هنا'];
      const seen = new Set<string>();
      const scored: { el: Element; inVp: number; top: number }[] = [];
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], a'))) {
        const text = (el as HTMLElement).textContent?.trim() ?? '';
        if (text.length < 3 || text.length > 30) continue;
        if (vague.includes(text.toLowerCase()) || seen.has(text.toLowerCase())) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= window.innerWidth) continue;
        seen.add(text.toLowerCase());
        scored.push({ el, inVp: r.top >= 0 && r.bottom <= window.innerHeight ? 0 : 1, top: r.top });
      }
      scored.sort((a, b) => a.inVp - b.inVp || a.top - b.top);
      for (const s of scored.slice(0, 5)) s.el.setAttribute('data-sitecheck-clearbtn', '1');
    }).catch(() => { /* evidence only */ });

    await recorder?.setCaption('Q20 — Highlighting clearly labeled buttons and links…');
    dbg('Q20: highlighting representative labeled controls');
    const ss = ssPath(auditJobId, '20');
    await takeMultiHighlightScreenshot(page, ss.abs, [
      { selector: '[data-sitecheck-clearbtn]', label: 'Clearly Labeled Controls' },
    ], {
      holdMs: recorder ? 2000 : 400,
      maxBox: { width: 450, height: 120 },
    });
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-sitecheck-clearbtn]'))) {
        el.removeAttribute('data-sitecheck-clearbtn');
      }
    }).catch(() => { /* evidence only */ });

    const vagueRatio = data.totalLinks > 0 ? data.vagueLinks / data.totalLinks : 0;
    const emptyButtonRatio = data.totalButtons > 0 ? data.emptyButtons / data.totalButtons : 0;
    const passed = vagueRatio <= 0.15 && emptyButtonRatio <= 0.1;

    const stampNote = recorder ? ` [${recorder.stamp()}]` : '';
    return makeResult('Q20', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Links: ${data.totalLinks} (vague: ${data.vagueLinks}). Buttons: ${data.totalButtons} (empty: ${data.emptyButtons}).${stampNote}`,
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
  page: Page, url: string, auditJobId: string, hasSearch: boolean, serviceName?: string,
): Promise<CriterionResult> {
  if (!hasSearch) {
    return makeResult('Q21', { status: 'skipped', notes: 'Skipped — no search bar found (Q13).' });
  }
  try {
    const isArabic = await page.evaluate(
      () => /[؀-ۿ]/.test(document.body.innerText.substring(0, 2000))
    );
    // Prefer the evaluator-supplied assessed service name (from the new-audit form);
    // fall back to a generic "services" query when none was provided.
    const svc = (serviceName || '').trim();
    const query = svc || (isArabic ? 'خدمات' : 'services');
    const usedServiceName = svc.length > 0;
    dbg(`Q21: searching for "${query}"${usedServiceName ? ' (evaluator service name)' : ' (default query)'}`);

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
    const queryNote = usedServiceName ? ' (query = assessed service name from audit setup)' : '';

    if (!hasResults) {
      await navigateAndWait(page, url);
      return makeResult('Q21', {
        scoreEarned: 0,
        status: 'fail',
        screenshotPath: ss.rel,
        notes: `Searched for "${query}"${queryNote} but no results were shown${results.noResults ? ' (explicit no-results message)' : ''}.`,
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
        notes: `Search for "${query}"${queryNote} returned ${results.resultLinks.length}+ relevant results and the first result page loads correctly.${results.mentionsQuery ? '' : ' (Note: result text did not explicitly contain the query term.)'}`,
        recommendation: '',
      });
    }
    return makeResult('Q21', {
      scoreEarned: 1,
      status: 'partial',
      screenshotPath: ss.rel,
      notes: `Search for "${query}"${queryNote} returned results, but the first result page failed to load or was empty.`,
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
// Evidence selectors for a shot of the FAQ section itself (after expansion).
const FAQ_SECTION_SHOT_SELECTORS = [
  'h1:has-text("Frequently Asked")', 'h2:has-text("Frequently Asked")',
  'h1:has-text("الأسئلة الشائعة")', 'h2:has-text("الأسئلة الشائعة")',
  '[class*="faq" i]', '[id*="faq" i]', '[class*="accordion" i]',
];

// Open (expand) up to `max` FAQ questions so the answers are visible — on
// camera for recorded runs. Falls back to a read-through scroll when the FAQ
// is plain text with nothing to expand. Best-effort, returns questions viewed.
async function viewFaqQuestions(pageCtx: Page, recorder?: EvidenceRecorder, max = 2): Promise<number> {
  let viewed = 0;
  try {
    const toggleSelectors = [
      'details > summary',
      '[class*="faq" i] [aria-expanded="false"]',
      '[class*="accordion" i] [aria-expanded="false"]',
      '[class*="faq" i] button', '[class*="accordion" i] button',
      '[aria-expanded="false"]',
    ];
    const seenTexts = new Set<string>();
    for (const sel of toggleSelectors) {
      if (viewed >= max) break;
      const candidates = await pageCtx.locator(sel).all().catch(() => []);
      for (const cand of candidates.slice(0, 12)) {
        if (viewed >= max) break;
        const text = ((await cand.textContent().catch(() => '')) || '').trim();
        // Question-length text only — skips nav toggles and icon buttons.
        if (text.length < 10 || text.length > 150) continue;
        const key = text.toLowerCase();
        if (seenTexts.has(key)) continue;
        const box = await cand.boundingBox().catch(() => null);
        if (!box || box.width < 2 || box.height < 2) continue;
        try {
          await recorder?.setCaption(`Q22 — Reading FAQ question ${viewed + 1}…`);
          dbg(`Q22: expanding FAQ question ${viewed + 1}/${max}: "${text.slice(0, 60)}"`);
          await cand.scrollIntoViewIfNeeded().catch(() => {});
          await clickWithHighlight(cand, { holdMs: recorder ? 1000 : 200, timeout: 3000 });
          await pageCtx.waitForTimeout(recorder ? 1000 : 300);
          seenTexts.add(key);
          viewed++;
        } catch { /* try the next candidate */ }
      }
    }
    if (viewed === 0) {
      await recorder?.setCaption('Q22 — Reviewing the FAQ questions…');
      dbg('Q22: no expandable FAQ items — scrolling through the section');
      await humanScrollVerify(pageCtx, { maxSteps: 4 });
    }
  } catch { /* evidence only — never affects the score */ }
  return viewed;
}

async function checkQ22(
  page: Page, url: string, auditJobId: string, recorder?: EvidenceRecorder,
): Promise<CriterionResult> {
  try {
    await recorder?.setCaption('Q22 — Looking for an FAQ section…');
    dbg('Q22: scanning for FAQ links/sections…');
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
      const faqAnchor = (navAnchors.find(isFaqLink) ??
        Array.from(document.querySelectorAll('a')).find(isFaqLink)) as HTMLAnchorElement | undefined;

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

      return {
        inNav,
        faqHref: faqAnchor?.href ?? null,
        supportHref: supportAnchor?.href ?? null,
        anyFaqLink, faqSections, hasFaqText,
      };
    });

    const ss = ssPath(auditJobId, '22');
    const stampNote = () => (recorder ? ` [${recorder.stamp()}]` : '');
    const viewedNote = (n: number) => n > 0
      ? ` Viewed ${n} FAQ question(s).`
      : (recorder ? ' FAQ shown as plain text — read through on camera.' : '');
    const restoreHome = async () => {
      dbg('Q22: restoring homepage');
      await navigateAndWait(page, url, { waitAfter: 1500 });
      await dismissCookieBanner(page);
    };

    if (data.inNav) {
      if (recorder && data.faqHref) {
        // On camera: open the FAQ page and read at least two questions.
        dbg(`Q22: FAQ link in navigation — opening ${data.faqHref}`);
        await recorder.setCaption('Q22 — FAQ link found in the navigation — opening it…');
        await humanNavigate(page, data.faqHref, recorder);
        await dismissCookieBanner(page);
        const viewed = await viewFaqQuestions(page, recorder);
        await takeHighlightedScreenshot(page, ss.abs, FAQ_SECTION_SHOT_SELECTORS, {
          contextualZoom: true,
          label: 'FAQ Section',
        });
        const result = makeResult('Q22', {
          scoreEarned: 2,
          status: 'pass',
          screenshotPath: ss.rel,
          notes: `FAQ link available in the header/navigation/footer — easy to find.${viewedNote(viewed)}${stampNote()}`,
          recommendation: '',
        });
        await restoreHome();
        return result;
      }
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
        notes: `FAQ link available in the header/navigation/footer — easy to find.${stampNote()}`,
        recommendation: '',
      });
    }

    // No direct FAQ link — check the Support/Help section, where FAQ
    // commonly lives (e.g. TAMM's Support menu).
    const faqOnSupportEval = () => {
      const text = document.body.innerText.toLowerCase();
      const hasFaqText =
        text.includes('frequently asked') || text.includes('faq') ||
        text.includes('الأسئلة الشائعة') || text.includes('أسئلة متكررة');
      const faqSections = document.querySelectorAll(
        '[class*="faq" i], [id*="faq" i], details, [class*="accordion" i]'
      ).length;
      return { hasFaqText, faqSections };
    };

    if (data.supportHref && recorder) {
      // On camera: open the Support page on the recorded page.
      dbg(`Q22: opening support page ${data.supportHref}`);
      await recorder.setCaption('Q22 — Opening the Support page to look for FAQs…');
      await humanNavigate(page, data.supportHref, recorder);
      await page.waitForTimeout(1500);
      await dismissCookieBanner(page);
      const faqOnSupport = await page.evaluate(faqOnSupportEval);
      if (faqOnSupport.hasFaqText || faqOnSupport.faqSections > 0) {
        dbg('Q22: FAQ found on the support page');
        const viewed = await viewFaqQuestions(page, recorder);
        await takeHighlightedScreenshot(page, ss.abs, FAQ_SECTION_SHOT_SELECTORS, {
          contextualZoom: true,
          label: 'FAQ Section',
        });
        const result = makeResult('Q22', {
          scoreEarned: 2,
          status: 'pass',
          screenshotPath: ss.rel,
          notes: `FAQ easily reachable via the Support/Help menu — FAQ section found on the support page.${viewedNote(viewed)}${stampNote()}`,
          recommendation: '',
        });
        await restoreHome();
        return result;
      }
      dbg('Q22: no FAQ on the support page');
      await restoreHome();
    } else if (data.supportHref) {
      const sp = await page.context().newPage();
      try {
        await sp.goto(data.supportHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sp.waitForTimeout(3000);
        await dismissCookieBanner(sp);
        const faqOnSupport = await sp.evaluate(faqOnSupportEval);
        if (faqOnSupport.hasFaqText || faqOnSupport.faqSections > 0) {
          const viewed = await viewFaqQuestions(sp, undefined);
          await takeHighlightedScreenshot(sp, ss.abs, FAQ_SECTION_SHOT_SELECTORS, {
            contextualZoom: true,
            label: 'FAQ Section',
          });
          return makeResult('Q22', {
            scoreEarned: 2,
            status: 'pass',
            screenshotPath: ss.rel,
            notes: `FAQ easily reachable via the Support/Help menu — FAQ section found on the support page.${viewedNote(viewed)}`,
            recommendation: '',
          });
        }
      } catch { /* best effort */ } finally {
        await sp.close().catch(() => null);
      }
    }

    if (recorder) {
      await recorder.setCaption(
        data.anyFaqLink || data.faqSections > 0 || data.hasFaqText
          ? 'Q22 — FAQ content exists but is not linked from the navigation'
          : 'Q22 — No FAQ section found on this website',
      );
      await page.waitForTimeout(1200);
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
        notes: `FAQ content exists but is not linked from the header/nav/footer or Support section — available but not easy to find. (Links: ${data.anyFaqLink ? 'yes' : 'no'}, sections: ${data.faqSections}, text: ${data.hasFaqText ? 'yes' : 'no'}.)${stampNote()}`,
      });
    }
    return makeResult('Q22', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `No FAQ section, link, or related content found (homepage and Support section checked).${stampNote()}`,
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
  serviceName: string;
  previousResults: CriterionResult[];
  recorder?: EvidenceRecorder;
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, entityName, serviceName, recorder } = params;
  const results: CriterionResult[] = [];

  dbg(`starting Navigation pillar for "${entityName}" (${url})${recorder ? ' — recording' : ''}`);
  await recorder?.setCaption(`Pillar 4 — Navigation & Ease of Use: automated check for "${entityName}"`);
  if (recorder) await page.waitForTimeout(1200);

  // Clear cookie banners before any evidence screenshots
  await dismissCookieBanner(page);

  results.push(await checkQ12(page, url, auditJobId, recorder));

  const q13 = await checkQ13(page, url, auditJobId, recorder);
  results.push(q13.result);

  results.push(await checkQ16(page, url, auditJobId, recorder));

  const fb = await runFeedbackJourney(page, url, auditJobId, recorder);
  results.push(fb.q17, fb.q17_1);

  results.push(await checkQ18(page, auditJobId, recorder));
  results.push(await checkQ19(page, auditJobId, recorder));
  results.push(await checkQ20(page, auditJobId, recorder));
  results.push(await checkQ22(page, url, auditJobId, recorder));

  // Q21 and Q30 navigate away from the homepage — run them last
  await recorder?.setCaption('Q21 — Testing the search with a real query…');
  results.push(await checkQ21(page, url, auditJobId, q13.hasSearch, serviceName));
  await recorder?.setCaption('Q30 — Testing browser back/forward navigation…');
  results.push(await checkQ30(page, url, auditJobId));

  await recorder?.setCaption('Pillar 4 — Navigation checks complete');
  if (recorder) await page.waitForTimeout(1500);

  return results;
}
