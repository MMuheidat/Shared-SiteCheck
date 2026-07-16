// lib/engine/pillar6-services.ts — Services & Content Information
// Q31 (channel detection) + branching Q32/Q33/Q34 variants a/b/c/d.
//
// Q31 determines WHERE the entity's services list lives, which selects the
// variant letter for the follow-up questions:
//   a = entity_website   (services on the entity's own site)
//   b = directs_to_tamm  (entity site auto-redirects to TAMM)
//   c = navigating_tamm  (services found by navigating TAMM)
//   d = navigating_atlp  (services found by navigating ATLP)
// Only the active channel's variant is evaluated; the other three are skipped.
// Q34 (consistency with the entity's official service catalogue) requires that
// external catalogue, so it is always left as manual review (na).

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeHighlightedScreenshot, dismissCookieBanner } from '@/lib/engine/helpers';

const PILLAR = 'Services';

type Channel = 'entity_website' | 'directs_to_tamm' | 'navigating_tamm' | 'navigating_atlp';
const CHANNEL_LETTER: Record<Channel, 'a' | 'b' | 'c' | 'd'> = {
  entity_website: 'a',
  directs_to_tamm: 'b',
  navigating_tamm: 'c',
  navigating_atlp: 'd',
};
const CHANNEL_LABEL: Record<Channel, string> = {
  entity_website: "the entity's own website",
  directs_to_tamm: 'the TAMM website (entity auto-redirects to TAMM)',
  navigating_tamm: 'the TAMM website (found by navigation)',
  navigating_atlp: 'the ATLP website',
};
const ALL_LETTERS: Array<'a' | 'b' | 'c' | 'd'> = ['a', 'b', 'c', 'd'];

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
const isAtlpHost = (h: string) => h.includes('atlp') || h.includes('adports');

const SERVICE_SELECTORS = [
  'nav a[href*="service" i]', 'header a[href*="service" i]',
  'a[href*="service" i]', 'a[href*="eservice" i]', 'a[href*="e-service" i]',
  'a[href*="خدمات"]', '[class*="service" i]', '[id*="service" i]',
];

async function cleanupHighlights(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('.sitecheck-p6-label').forEach(e => e.remove());
    document.querySelectorAll('[data-sitecheck-hl]').forEach(el => {
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.boxShadow = '';
      el.removeAttribute('data-sitecheck-hl');
    });
  }).catch(() => {});
}

// Highlight the whole services-list section (found generically via its heading),
// not a single service card. Returns true if a section was highlighted.
async function highlightServicesList(page: Page, label: string): Promise<boolean> {
  return page.evaluate((lbl: string) => {
    const heads = Array.from(document.querySelectorAll('h1, h2, h3, h4'));
    const heading = heads.find(h => {
      const t = (h.textContent || '').trim().toLowerCase();
      return /(^|\b)(list of services|our services|e-?services|all services|services)\b/.test(t) ||
        t.includes('قائمة الخدمات') || t.includes('الخدمات') || t.includes('خدماتنا');
    }) as HTMLElement | undefined;
    if (!heading) return false;

    // Climb to the container that holds the grid of service links
    let container: HTMLElement = heading;
    for (let i = 0; i < 6 && container.parentElement; i++) {
      if (container.querySelectorAll('a[href]').length >= 6) break;
      container = container.parentElement;
    }

    heading.scrollIntoView({ behavior: 'instant', block: 'start' });
    container.setAttribute('data-sitecheck-hl', '1');
    container.style.outline = '4px solid red';
    container.style.outlineOffset = '-4px';
    container.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';

    const el = document.createElement('div');
    el.className = 'sitecheck-p6-label';
    el.textContent = lbl;
    el.style.cssText =
      'position:fixed; top:8px; left:8px; background:red; color:white; padding:4px 8px; ' +
      'font-size:14px; font-weight:bold; border-radius:4px; z-index:999999; pointer-events:none;';
    document.body.appendChild(el);
    return true;
  }, label).catch(() => false);
}

// ────────────────────────────────────────────────────────────
//  Channel detection (the Q31 brain)
// ────────────────────────────────────────────────────────────
async function detectChannel(
  page: Page, url: string,
): Promise<{ channel: Channel; redirected: boolean; signals: string[] }> {
  const auditedHost = hostOf(url);
  const finalHost = hostOf(page.url());
  const redirected = !!finalHost && !!auditedHost && finalHost !== auditedHost;
  const signals: string[] = [];

  const pageData = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const hasTammLink = anchors.some(a => /tamm\.abudhabi|tamm\.ae/i.test(a.href));
    const hasAtlpLink = anchors.some(a => /atlp|adports/i.test(a.href));
    const serviceLinks = document.querySelectorAll(
      'nav a[href*="service" i], header a[href*="service" i], a[href*="service" i], a[href*="eservice" i], a[href*="خدمات"]'
    ).length;
    const text = document.body.innerText.toLowerCase();
    const hasServiceText =
      text.includes('services') || text.includes('e-service') ||
      text.includes('خدمات') || text.includes('الخدمات');
    return { hasTammLink, hasAtlpLink, serviceLinks, hasServiceText };
  });

  const ownServices = pageData.serviceLinks > 0 || pageData.hasServiceText;

  let channel: Channel;
  if (redirected && isTammHost(finalHost)) {
    // The entity's site auto-redirected us to TAMM → it does not host services itself
    channel = 'directs_to_tamm';
    signals.push(`Entity site auto-redirected to TAMM: ${auditedHost} → ${finalHost}.`);
  } else if (redirected && isAtlpHost(finalHost)) {
    channel = 'navigating_atlp';
    signals.push(`Entity site auto-redirected to ATLP: ${auditedHost} → ${finalHost}.`);
  } else if (ownServices) {
    // The audited site (whatever it is — including TAMM itself when TAMM is the
    // audited entity) has its OWN services list. That is the entity website.
    channel = 'entity_website';
    signals.push(`The audited site hosts its own services list (${pageData.serviceLinks} service link(s)).`);
  } else if (pageData.hasTammLink) {
    // No own services, no auto-redirect, but points to TAMM → found by navigating TAMM
    channel = 'navigating_tamm';
    signals.push('Audited site has no own service list but links to TAMM — services found by navigating TAMM.');
  } else if (pageData.hasAtlpLink) {
    channel = 'navigating_atlp';
    signals.push('Audited site has no own service list but links to ATLP — services found by navigating ATLP.');
  } else {
    channel = 'entity_website';
    signals.push('No clear service channel detected — defaulting to entity website (manual review advised).');
  }
  return { channel, redirected, signals };
}

// ────────────────────────────────────────────────────────────
//  Q31 — Services list availability + channel
// ────────────────────────────────────────────────────────────
async function checkQ31(
  page: Page, url: string, auditJobId: string,
): Promise<{ result: CriterionResult; channel: Channel; found: boolean }> {
  try {
    const { channel, redirected, signals } = await detectChannel(page, url);

    const servicesPresent = await page.evaluate(() => {
      const links = document.querySelectorAll(
        'nav a[href*="service" i], header a[href*="service" i], a[href*="service" i], a[href*="eservice" i], a[href*="خدمات"]'
      ).length;
      const text = document.body.innerText.toLowerCase();
      const hasText = text.includes('services') || text.includes('خدمات') || text.includes('e-service');
      return links > 0 || hasText;
    });

    const ss = ssPath(auditJobId, '31');
    const highlighted = await highlightServicesList(page, 'Services List');
    if (highlighted) {
      await page.waitForTimeout(400);
      await viewportShot(page, ss.abs);
      await cleanupHighlights(page);
    } else {
      // No recognizable services section heading — fall back to element highlight
      await takeHighlightedScreenshot(page, ss.abs, SERVICE_SELECTORS, {
        contextualZoom: true,
        label: 'Services List',
        maxHighlightBox: { width: 900, height: 500 },
      });
    }

    const channelNote = `Coded as: ${CHANNEL_LABEL[channel]} (variant ${CHANNEL_LETTER[channel]}). ${signals.join(' ')}`;
    if (servicesPresent || redirected) {
      return {
        result: makeResult('Q31', {
          status: 'pass',
          screenshotPath: ss.rel,
          notes: `Services list is available on ${CHANNEL_LABEL[channel]}. ${channelNote}`,
          recommendation: '',
        }),
        channel,
        found: true,
      };
    }
    return {
      result: makeResult('Q31', {
        status: 'fail',
        screenshotPath: ss.rel,
        notes: `No services list detected on any channel. ${channelNote}`,
      }),
      channel,
      found: false,
    };
  } catch (err: unknown) {
    return {
      result: makeResult('Q31', { status: 'na', notes: `Error: ${err instanceof Error ? err.message : String(err)}` }),
      channel: 'entity_website',
      found: false,
    };
  }
}

// ────────────────────────────────────────────────────────────
//  Q32{letter} — Information tailored to user groups
// ────────────────────────────────────────────────────────────
async function checkQ32(page: Page, auditJobId: string, letter: string, channelLabel: string): Promise<CriterionResult> {
  const qid = `Q32${letter}`;
  try {
    const data = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const groups = [
        'individual', 'business', 'company', 'companies', 'investor', 'visitor',
        'citizen', 'resident', 'tourist', 'entrepreneur',
        'أفراد', 'الأفراد', 'شركات', 'الشركات', 'مستثمر', 'زوار', 'مواطن', 'مقيم', 'سياح',
      ];
      const found = Array.from(new Set(groups.filter(g => text.includes(g))));
      // Segmentation UI: audience tabs / links / cards
      const segEls = document.querySelectorAll(
        '[class*="user-group" i], [class*="audience" i], [class*="segment" i], ' +
        '[data-audience], [data-segment], [role="tab"], ' +
        'a[href*="individual" i], a[href*="business" i], a[href*="investor" i], a[href*="visitor" i]'
      ).length;
      return { found, segEls };
    });

    const ss = ssPath(auditJobId, `32${letter}`);
    await takeHighlightedScreenshot(page, ss.abs, [
      'a[href*="individual" i]', 'a[href*="business" i]', 'a[href*="investor" i]', 'a[href*="visitor" i]',
      '[class*="audience" i]', '[class*="segment" i]', '[role="tab"]',
    ], {
      contextualZoom: true,
      label: 'User Group Segmentation',
      maxHighlightBox: { width: 700, height: 250 },
    });

    // Distinct group terms (need at least two different audiences) or explicit segmentation UI
    const distinctGroups = data.found.length;
    const passed = distinctGroups >= 2 || data.segEls > 0;

    return makeResult(qid, {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Checked on ${channelLabel}. User groups found: ${data.found.length ? data.found.join(', ') : 'none'}. Segmentation UI elements: ${data.segEls}.`,
      recommendation: passed ? '' : getRecommendation(qid),
    });
  } catch (err: unknown) {
    return makeResult(qid, { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// Detect the four required service-info fields on the current page.
// Self-contained for page.evaluate.
function detectServiceFields() {
  const text = document.body.innerText.toLowerCase();
  const fields = {
    fees:
      /\bfee(s)?\b/.test(text) || text.includes('cost') || text.includes('charge') ||
      text.includes('aed') || text.includes('free of charge') || text.includes('الرسوم') ||
      text.includes('التكلفة') || text.includes('مجاني') || text.includes('رسوم'),
    procedures:
      text.includes('step') || text.includes('procedure') || text.includes('how to apply') ||
      text.includes('process') || text.includes('الخطوات') || text.includes('الإجراءات') || text.includes('كيفية'),
    deliveryTime:
      text.includes('processing time') || text.includes('turnaround') || text.includes('working days') ||
      text.includes('duration') || text.includes('service time') || text.includes('المدة') ||
      text.includes('مدة') || text.includes('أيام عمل') || text.includes('وقت'),
    requiredDocuments:
      text.includes('required document') || text.includes('documents required') || text.includes('documents needed') ||
      text.includes('attachments') || text.includes('الوثائق') || text.includes('المستندات') || text.includes('المرفقات'),
  };
  const count = Object.values(fields).filter(Boolean).length;
  return { fields, count };
}

// ────────────────────────────────────────────────────────────
//  Q33{letter} — Complete service information
//  (Fees, Service Procedures, Delivery Time, Required Documents)
//  Service listings are often nested (home → category → service detail), so
//  this drills into the deepest service link until the info fields appear.
// ────────────────────────────────────────────────────────────
async function checkQ33(
  page: Page, url: string, auditJobId: string, letter: string, channelLabel: string,
): Promise<CriterionResult> {
  const qid = `Q33${letter}`;
  try {
    // Descend the service catalogue by CHILD PATH: from the current page, follow
    // a service link whose path is a child of the current path (category →
    // subcategory → service detail). Descending the same branch avoids grabbing
    // unrelated deep links like /terms-of-service or /help-with-services.
    const childServiceLink = () => page.evaluate(() => {
      const curPath = location.pathname.replace(/\/+$/, '');
      const EXCLUDE = /terms|privacy|policy|cookie|about|contact|sitemap|help|support|faq|login|signin|register/i;
      const depth = (p: string) => p.split('/').filter(Boolean).length;
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => (a as HTMLAnchorElement).href)
        .filter(h => !h.includes('#'));
      const sameOrigin = Array.from(new Set(links)).filter(h => {
        try { return new URL(h).origin === location.origin; } catch { return false; }
      });
      const looksService = (p: string) => /service|خدمة|خدمات|eservice|life-event/i.test(p);
      // Prefer strict children of the current path; fall back to any deeper service link
      const children = sameOrigin.filter(h => {
        try {
          const p = new URL(h).pathname.replace(/\/+$/, '');
          return p.startsWith(curPath + '/') && depth(p) > depth(curPath) && !EXCLUDE.test(p);
        } catch { return false; }
      });
      const pool = children.length ? children : sameOrigin.filter(h => {
        try {
          const p = new URL(h).pathname.replace(/\/+$/, '');
          return depth(p) > depth(curPath) && looksService(p) && !EXCLUDE.test(p);
        } catch { return false; }
      });
      // Deepest first — the most specific page is most likely the service detail
      pool.sort((a, b) => {
        try { return depth(new URL(b).pathname) - depth(new URL(a).pathname); } catch { return 0; }
      });
      return pool[0] || null;
    });

    let navigated = false;
    let best = await page.evaluate(detectServiceFields);
    let bestUrl = page.url();

    // Drill down toward a service-detail page (home → category → subcat → detail)
    for (let hop = 0; hop < 4 && best.count < 3; hop++) {
      const next = await childServiceLink();
      if (!next || next.replace(/\/+$/, '') === page.url().replace(/\/+$/, '')) break;
      try {
        await navigateAndWait(page, next, { waitAfter: 2500 });
        await dismissCookieBanner(page);
        navigated = true;
      } catch { break; }
      const d = await page.evaluate(detectServiceFields);
      if (d.count > best.count) { best = d; bestUrl = page.url(); }
    }

    // Ensure the screenshot matches the best page we found
    if (page.url() !== bestUrl) {
      try { await navigateAndWait(page, bestUrl, { waitAfter: 2000 }); await dismissCookieBanner(page); } catch { /* */ }
    }
    const ss = ssPath(auditJobId, `33${letter}`);
    await viewportShot(page, ss.abs);

    // Return to the services base afterwards
    if (navigated) { try { await navigateAndWait(page, url, { waitAfter: 2000 }); await dismissCookieBanner(page); } catch { /* */ } }

    const detail = Object.entries(best.fields).map(([k, v]) => `${k}: ${v ? '✓' : '✗'}`).join(', ');
    const passed = best.count >= 3; // at least 3 of the 4 required info types

    return makeResult(qid, {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Checked on ${channelLabel} (service detail: ${bestUrl}). Service info present (${best.count}/4): ${detail}.`,
      recommendation: passed ? '' : getRecommendation(qid),
    });
  } catch (err: unknown) {
    return makeResult(qid, { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q34{letter} — Consistency with the entity's service catalogue
//  Requires the entity's official catalogue → always manual review.
// ────────────────────────────────────────────────────────────
async function checkQ34(page: Page, auditJobId: string, letter: string, channelLabel: string): Promise<CriterionResult> {
  const qid = `Q34${letter}`;
  try {
    const ss = ssPath(auditJobId, `34${letter}`);
    await viewportShot(page, ss.abs);
    return makeResult(qid, {
      status: 'na',
      screenshotPath: ss.rel,
      notes: `Manual review required — compare the service information on ${channelLabel} against the entity's official service catalogue. This cannot be verified automatically.`,
    });
  } catch (err: unknown) {
    return makeResult(qid, { status: 'na', notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar6Services(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId } = params;
  const results: CriterionResult[] = [];

  await dismissCookieBanner(page);

  const q31 = await checkQ31(page, url, auditJobId);
  results.push(q31.result);

  const activeLetter = CHANNEL_LETTER[q31.channel];
  const channelLabel = CHANNEL_LABEL[q31.channel];

  for (const letter of ALL_LETTERS) {
    if (letter === activeLetter && q31.found) {
      results.push(await checkQ32(page, auditJobId, letter, channelLabel));
      results.push(await checkQ33(page, url, auditJobId, letter, channelLabel));
      results.push(await checkQ34(page, auditJobId, letter, channelLabel));
    } else {
      // Inactive channel (or services not found) — not applicable, excluded from scoring
      const skipNote = q31.found
        ? `Not applicable — services are on ${channelLabel} (variant ${activeLetter}), not this channel.`
        : 'Skipped — no services list detected in Q31.';
      results.push(makeResult(`Q32${letter}`, { status: 'skipped', notes: skipNote }));
      results.push(makeResult(`Q33${letter}`, { status: 'skipped', notes: skipNote }));
      results.push(makeResult(`Q34${letter}`, { status: 'skipped', notes: skipNote }));
    }
  }

  return results;
}
