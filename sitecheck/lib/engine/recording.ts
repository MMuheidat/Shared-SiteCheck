// lib/engine/recording.ts — Per-pillar screen-recording evidence
//
// The engine runs a recording-enabled pillar inside a dedicated browser context
// with `recordVideo` (Playwright videos only finalize on context close — see the
// Pillar 9 live-chat precedent). On top of the raw recording this module adds:
//   - a click "ripple": a red ring flashed at every click position, since
//     Playwright videos never show the OS cursor
//   - `clickWithHighlight`: red outline around an element before clicking it,
//     for deliberate, auditor-visible interactions
//   - `setCaption`: a persistent banner describing what is being checked,
//     re-applied automatically after each navigation
//
// Everything here is evidence cosmetics: helpers are best-effort and must never
// cause a criterion to fail.

import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';

export interface EvidenceRecorder {
  page: Page;
  context: BrowserContext;
  /** Show/replace the on-screen caption banner; persists across navigations. */
  setCaption(text: string): Promise<void>;
  /** "video @ m:ss" offset since recording start, for jump-to notes. */
  stamp(): string;
  /** Close the context, flush the video to /screenshots/<id>/<slug>.webm, return the rel path. */
  finish(): Promise<string | null>;
}

export const CAPTION_ELEMENT_ID = '__sitecheck_caption';

// Red ring flashed at the click point. Installed as an init script so it
// re-arms itself on every navigation. Trusted clicks from Playwright fire
// normal DOM listeners, so no call-site changes are needed.
const CLICK_RIPPLE_INIT_SCRIPT = `
(() => {
  if (window.__sitecheckRipple) return;
  window.__sitecheckRipple = true;
  document.addEventListener('mousedown', (ev) => {
    try {
      if (!document.body) return;
      const ring = document.createElement('div');
      ring.style.cssText = [
        'position: fixed',
        'left: ' + (ev.clientX - 22) + 'px',
        'top: ' + (ev.clientY - 22) + 'px',
        'width: 44px',
        'height: 44px',
        'border: 4px solid red',
        'border-radius: 50%',
        'box-shadow: 0 0 15px rgba(255, 0, 0, 0.6)',
        'pointer-events: none',
        'z-index: 2147483647',
        'transition: transform 0.7s ease-out, opacity 0.7s ease-out',
      ].join(';');
      document.body.appendChild(ring);
      requestAnimationFrame(() => {
        ring.style.transform = 'scale(1.6)';
        ring.style.opacity = '0';
      });
      setTimeout(() => ring.remove(), 800);
    } catch { /* cosmetics only */ }
  }, true);
})();
`;

function captionUpsert({ text, elementId }: { text: string; elementId: string }) {
  let el = document.getElementById(elementId);
  if (!el) {
    if (!document.body) return;
    el = document.createElement('div');
    el.id = elementId;
    el.style.cssText = [
      'position: fixed',
      'left: 0',
      'right: 0',
      'bottom: 0',
      'padding: 10px 18px',
      'background: rgba(15, 23, 42, 0.85)',
      'color: #ffffff',
      'font: bold 15px/1.4 Arial, sans-serif',
      'text-align: center',
      'direction: ltr', // captions are EN-led; RTL host pages (e.g. Arabic Maps) must not reorder them
      'unicode-bidi: plaintext',
      'pointer-events: none',
      'z-index: 2147483647',
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = text;
}

export async function startPillarRecording(
  browser: Browser,
  opts: { auditJobId: string; slug: string },
): Promise<EvidenceRecorder> {
  const { auditJobId, slug } = opts;
  const tmpDir = path.join(process.cwd(), 'public', 'screenshots', auditJobId, `video-tmp-${slug}`);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    recordVideo: { dir: tmpDir, size: { width: 1280, height: 720 } },
  });
  await context.addInitScript(CLICK_RIPPLE_INIT_SCRIPT);

  const page = await context.newPage();
  const video = page.video();
  const startedAt = Date.now();
  let currentCaption = '';

  const applyCaption = async () => {
    if (!currentCaption) return;
    try {
      await page.evaluate(captionUpsert, { text: currentCaption, elementId: CAPTION_ELEMENT_ID });
    } catch {
      /* navigation race / page closed — cosmetics only */
    }
  };

  // Navigations wipe the DOM; re-show the current caption on every new document.
  page.on('domcontentloaded', () => { void applyCaption(); });

  return {
    page,
    context,

    async setCaption(text: string) {
      currentCaption = text;
      await applyCaption();
    },

    stamp() {
      const totalSec = Math.floor((Date.now() - startedAt) / 1000);
      const m = Math.floor(totalSec / 60);
      const s = String(totalSec % 60).padStart(2, '0');
      return `video @ ${m}:${s}`;
    },

    async finish() {
      try {
        await context.close(); // finalizes the recording
      } catch (err) {
        console.error(`[SiteCheck] Recording context close failed (${slug}):`, err);
      }
      if (!video) return null;
      try {
        const target = path.join(process.cwd(), 'public', 'screenshots', auditJobId, `${slug}.webm`);
        await video.saveAs(target);
        await video.delete().catch(() => {});
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return `/screenshots/${auditJobId}/${slug}.webm`;
      } catch (err) {
        console.error(`[SiteCheck] Video save failed (${slug}):`, err);
        return null;
      }
    },
  };
}

/**
 * Slow, human-paced scroll down the page (visible wheel steps) to "verify" the
 * current state on video — e.g. after a language switch, text resize, or theme
 * change — then return to the top. Pillar 1 keeps its own shorter local
 * `humanScanScroll`; this is the shared, deeper variant for pillar journeys.
 * Pure evidence cosmetics: best-effort, must never fail a criterion.
 */
export async function humanScrollVerify(
  page: Page,
  opts?: { stepPx?: number; delayMs?: number; maxSteps?: number; returnToTop?: boolean },
): Promise<void> {
  const stepPx = opts?.stepPx ?? 300;
  const delayMs = opts?.delayMs ?? 400;
  const maxSteps = opts?.maxSteps ?? 10;
  const returnToTop = opts?.returnToTop ?? true;

  try {
    let steps = 0;
    while (steps < maxSteps) {
      const atBottom = await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        return el.scrollTop + window.innerHeight >= el.scrollHeight - 10;
      });
      if (atBottom) break;
      await page.mouse.wheel(0, stepPx);
      await page.waitForTimeout(delayMs);
      steps++;
    }
    await page.waitForTimeout(600); // linger at the deepest point

    if (returnToTop) {
      // Faster upward strokes — a human flicking back to the top
      for (let i = 0; i < Math.ceil((steps * stepPx) / 900) + 1; i++) {
        await page.mouse.wheel(0, -900);
        await page.waitForTimeout(200);
      }
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(300);
    }
  } catch {
    /* cosmetics only */
  }
}

/**
 * Click with a visible red outline held on the element beforehand, so the
 * recorded video clearly shows what is about to be clicked (the click ripple
 * fires as well). Falls back to a plain click if the styling fails.
 */
export async function clickWithHighlight(
  locator: Locator,
  opts?: { holdMs?: number; timeout?: number },
): Promise<void> {
  const holdMs = opts?.holdMs ?? 600;
  const timeout = opts?.timeout ?? 5000;

  let styled = false;
  try {
    await locator.evaluate((el: Element) => {
      const htmlEl = el as HTMLElement;
      htmlEl.dataset.sitecheckOutline = htmlEl.style.outline;
      htmlEl.dataset.sitecheckShadow = htmlEl.style.boxShadow;
      htmlEl.style.outline = '4px solid red';
      htmlEl.style.outlineOffset = '2px';
      htmlEl.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.6)';
      htmlEl.style.transition = 'none';
    }, undefined, { timeout });
    styled = true;
    await locator.page().waitForTimeout(holdMs);
  } catch {
    /* highlight is cosmetic */
  }

  await locator.click({ timeout });

  if (styled) {
    try {
      await locator.page().waitForTimeout(300);
      await locator.evaluate((el: Element) => {
        const htmlEl = el as HTMLElement;
        htmlEl.style.outline = htmlEl.dataset.sitecheckOutline || '';
        htmlEl.style.boxShadow = htmlEl.dataset.sitecheckShadow || '';
        delete htmlEl.dataset.sitecheckOutline;
        delete htmlEl.dataset.sitecheckShadow;
      }, undefined, { timeout: 2000 });
    } catch {
      /* element may be gone after the click — fine */
    }
  }
}
