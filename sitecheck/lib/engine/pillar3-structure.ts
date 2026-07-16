// lib/engine/pillar3-structure.ts — Q14 (Consistent Layout), Q15 (Device Agnostic), Q15b (Visual Content)

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeScreenshot, dismissCookieBanner } from '@/lib/engine/helpers';

const PILLAR = 'Website Structure';

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

// Medium-zoom evidence shot: capture the current viewport (height capped at
// 800px) instead of the full page, so highlighted elements stay readable.
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
    document.querySelectorAll('.sitecheck-p3-label').forEach(e => e.remove());
    document.querySelectorAll('[data-sitecheck-hl]').forEach(el => {
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.boxShadow = '';
      el.removeAttribute('data-sitecheck-hl');
    });
  }).catch(() => {});
}

// Outline the shared header/navigation and pin a corner label — used by Q14
// on the homepage and again on an internal page to show the same layout.
async function highlightLayout(page: Page, labelText: string): Promise<void> {
  await page.evaluate((lbl: string) => {
    window.scrollTo(0, 0);
    const target = (document.querySelector('header, [role="banner"]') ||
      document.querySelector('nav, [role="navigation"]')) as HTMLElement | null;
    if (target) {
      target.setAttribute('data-sitecheck-hl', '1');
      target.style.outline = '4px solid red';
      target.style.outlineOffset = '-4px';
      target.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';
    }
    const label = document.createElement('div');
    label.className = 'sitecheck-p3-label';
    label.textContent = lbl;
    label.style.cssText =
      'position:fixed; top:8px; left:8px; background:red; color:white; padding:4px 8px; ' +
      'font-size:14px; font-weight:bold; border-radius:4px; z-index:999999; pointer-events:none;';
    document.body.appendChild(label);
  }, labelText).catch(() => {});
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
//  Q14 — Consistent Layout
// ────────────────────────────────────────────────────────────
async function checkQ14(page: Page, url: string, auditJobId: string): Promise<CriterionResult> {
  try {
    // Capture structural signature from homepage
    const getSignature = async () => {
      return page.evaluate(() => {
        const header = document.querySelector('header, [role="banner"]');
        const nav = document.querySelector('nav, [role="navigation"]');
        const footer = document.querySelector('footer, [role="contentinfo"]');
        return {
          hasHeader: !!header,
          hasNav: !!nav,
          hasFooter: !!footer,
          headerTag: header?.tagName ?? null,
          navTag: nav?.tagName ?? null,
          footerTag: footer?.tagName ?? null,
          headerClasses: header?.className ?? null,
          footerClasses: footer?.className ?? null,
        };
      });
    };

    const homeSig = await getSignature();
    const ss = ssPath(auditJobId, '14');

    // Homepage evidence shot with the shared header/navigation highlighted
    await highlightLayout(page, 'Homepage — Shared Header/Navigation');
    await page.waitForTimeout(300);
    await viewportShot(page, ss.abs);
    await cleanupHighlights(page);

    // Navigate to internal pages and compare
    const internalLinks = await discoverInternalLinks(page, url, 3);
    let consistentCount = 0;
    let pagesChecked = 0;
    let internalShotTaken = false;

    for (const link of internalLinks) {
      try {
        await navigateAndWait(page, link);
        pagesChecked++;
        const pageSig = await getSignature();

        const isConsistent =
          pageSig.hasHeader === homeSig.hasHeader &&
          pageSig.hasNav === homeSig.hasNav &&
          pageSig.hasFooter === homeSig.hasFooter;

        if (isConsistent) consistentCount++;

        // Second evidence shot: the same layout on an internal page
        if (isConsistent && !internalShotTaken) {
          const ssInt = ssPath(auditJobId, '14', '_page1');
          await highlightLayout(page, 'Internal Page — Same Header/Navigation');
          await page.waitForTimeout(300);
          await viewportShot(page, ssInt.abs);
          await cleanupHighlights(page);
          internalShotTaken = true;
        }
      } catch { /* skip */ }
    }

    // Navigate back
    await navigateAndWait(page, url);

    const baseElements = [
      homeSig.hasHeader ? 'Header ✓' : 'Header ✗',
      homeSig.hasNav ? 'Nav ✓' : 'Nav ✗',
      homeSig.hasFooter ? 'Footer ✓' : 'Footer ✗',
    ].join(', ');

    if (!homeSig.hasHeader && !homeSig.hasNav && !homeSig.hasFooter) {
      return makeResult('Q14', {
        screenshotPath: ss.rel,
        notes: `No standard layout elements (header/nav/footer) detected. ${baseElements}`,
      });
    }

    if (pagesChecked === 0 || consistentCount === pagesChecked) {
      return makeResult('Q14', {
        scoreEarned: 1,
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Layout is consistent across ${pagesChecked + 1} pages. Homepage: ${baseElements}`,
        recommendation: '',
      });
    }

    return makeResult('Q14', {
      screenshotPath: ss.rel,
      notes: `Layout consistent on ${consistentCount}/${pagesChecked} internal pages. Homepage: ${baseElements}`,
    });
  } catch (err: unknown) {
    return makeResult('Q14', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q15 — Mobile Responsiveness
// ────────────────────────────────────────────────────────────
async function checkQ15(page: Page, url: string, auditJobId: string): Promise<CriterionResult> {
  try {
    // Check for viewport meta tag
    const viewportData = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
      return {
        hasViewport: !!meta,
        content: meta?.content ?? '',
      };
    });

    // Test at mobile viewport (phone)
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(1000);

    const ss = ssPath(auditJobId, '15');
    await takeScreenshot(page, ss.abs);

    // Check for horizontal overflow at mobile size
    const mobileData = await page.evaluate(() => {
      const body = document.body;
      const hasHorizontalOverflow = body.scrollWidth > window.innerWidth + 10; // 10px tolerance
      return { hasHorizontalOverflow, scrollWidth: body.scrollWidth, windowWidth: window.innerWidth };
    });

    // The criterion covers tablets too — repeat the overflow check at tablet size
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(1000);
    const tabletOverflow = await page.evaluate(
      () => document.body.scrollWidth > window.innerWidth + 10
    );

    // Restore viewport
    if (originalViewport) {
      await page.setViewportSize(originalViewport);
    } else {
      await page.setViewportSize({ width: 1280, height: 720 });
    }

    const notes: string[] = [];
    notes.push(`Viewport meta tag: ${viewportData.hasViewport ? 'Yes' : 'No'}`);
    if (viewportData.hasViewport) notes.push(`Content: "${viewportData.content}"`);
    notes.push(`Horizontal overflow at 375px (phone): ${mobileData.hasHorizontalOverflow ? 'Yes (problem)' : 'No (good)'}`);
    notes.push(`Horizontal overflow at 768px (tablet): ${tabletOverflow ? 'Yes (problem)' : 'No (good)'}`);

    const passed = viewportData.hasViewport && !mobileData.hasHorizontalOverflow && !tabletOverflow;

    return makeResult('Q15', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: notes.join(' | '),
      recommendation: passed ? '' : getRecommendation('Q15'),
    });
  } catch (err: unknown) {
    return makeResult('Q15', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Q15b — Clear, relevant, visually appealing images and videos
//  (evidence-only, not scored)
//  Automation proxy: media must be present, load correctly (not broken),
//  and not be badly upscaled (rendered far beyond natural resolution ⇒ blurry).
//  Evidence: the most prominent image/video highlighted at medium zoom.
// ────────────────────────────────────────────────────────────
async function checkQ15b(page: Page, auditJobId: string): Promise<CriterionResult> {
  try {
    const media = await page.evaluate(() => {
      const isVisible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width >= 80 && r.height >= 60 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const imgs = Array.from(document.querySelectorAll('img')).filter(isVisible);
      const broken = imgs.filter(i => i.complete && i.naturalWidth === 0);
      const upscaled = imgs.filter(
        i => i.naturalWidth > 0 && i.getBoundingClientRect().width > i.naturalWidth * 1.5
      );
      const videos = Array.from(document.querySelectorAll('video')).filter(v => isVisible(v as HTMLElement)).length;
      const embeds = Array.from(document.querySelectorAll('iframe[src]')).filter(f =>
        /youtube|youtu\.be|vimeo|dailymotion|wistia|video/i.test((f as HTMLIFrameElement).src)
      ).length;
      return { images: imgs.length, broken: broken.length, upscaled: upscaled.length, videos, embeds };
    });

    const ss = ssPath(auditJobId, '15b');

    // Highlight the most prominent (largest visible) image or video
    await page.evaluate(() => {
      const isVisible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width >= 80 && r.height >= 60 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const candidates = [
        ...Array.from(document.querySelectorAll('img')),
        ...Array.from(document.querySelectorAll('video')),
      ].filter(el => isVisible(el as HTMLElement)) as HTMLElement[];
      if (!candidates.length) return;

      const target = candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })[0];

      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      target.setAttribute('data-sitecheck-hl', '1');
      target.style.outline = '4px solid red';
      target.style.outlineOffset = '-4px';
      target.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';

      const label = document.createElement('div');
      label.className = 'sitecheck-p3-label';
      label.textContent = 'Visual Content';
      label.style.cssText =
        'position:absolute; background:red; color:white; padding:4px 8px; font-size:14px; ' +
        'font-weight:bold; border-radius:4px; z-index:999999; pointer-events:none;';
      document.body.appendChild(label);

      const rect = target.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      let top = rect.top + window.scrollY - labelRect.height - 8;
      let left = rect.left + window.scrollX;
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
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    const summary =
      `Visible images: ${media.images} (${media.broken} broken, ${media.upscaled} upscaled/blurry), ` +
      `videos: ${media.videos}, video embeds: ${media.embeds}.`;

    if (media.images === 0 && media.videos === 0 && media.embeds === 0) {
      return makeResult('Q15b', {
        status: 'fail',
        screenshotPath: ss.rel,
        notes: `No prominent images or videos found on the page. ${summary}`,
      });
    }

    const brokenOk = media.broken === 0;
    const upscaledOk = media.images === 0 || media.upscaled / media.images <= 0.3;

    if (brokenOk && upscaledOk) {
      return makeResult('Q15b', {
        status: 'pass',
        screenshotPath: ss.rel,
        notes: `Clear visual content in use — media loads correctly at appropriate resolution. ${summary} ` +
          'Screenshot highlights the most prominent visual element.',
      });
    }
    return makeResult('Q15b', {
      status: 'fail',
      screenshotPath: ss.rel,
      notes: `Visual content has quality issues (broken or low-resolution/stretched media). ${summary}`,
    });
  } catch (err: unknown) {
    return makeResult('Q15b', { notes: `Error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar3Structure(params: {
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

  results.push(await checkQ14(page, url, auditJobId));
  results.push(await checkQ15(page, url, auditJobId));
  results.push(await checkQ15b(page, auditJobId));

  return results;
}
