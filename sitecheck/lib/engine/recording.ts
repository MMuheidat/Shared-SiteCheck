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

// ────────────────────────────────────────────────────────────
//  Stopwatch overlay (Pillar 7 — Q67 load-time proof)
//
//  A top-right on-screen timer that starts at a click and freezes when the page
//  has fully rendered. State lives in sessionStorage so the ticker survives the
//  white-flash of a full-page (same-origin) navigation — the timer visibly keeps
//  counting through the transition, then freezes on the loaded page.
//  Keys: __sc_timer_state (running|stopped), __sc_timer_start (epoch ms),
//        __sc_timer_final (ms), __sc_timer_threshold (ms), __sc_timer_label.
//  Pure evidence cosmetics: every call is best-effort and must never fail a check.
// ────────────────────────────────────────────────────────────
const STOPWATCH_INIT_SCRIPT = `
(() => {
  if (window.__scTimerArmed) return;
  window.__scTimerArmed = true;
  var ID = '__sitecheck_timer';
  function render() {
    try {
      var state = sessionStorage.getItem('__sc_timer_state');
      var el = document.getElementById(ID);
      if (!state) { if (el) el.remove(); return; }
      if (!document.body) return;
      if (!el) {
        el = document.createElement('div');
        el.id = ID;
        el.style.cssText = [
          'position: fixed', 'top: 16px', 'right: 16px',
          'padding: 8px 16px', 'background: rgba(15, 23, 42, 0.9)',
          'border: 3px solid #e5e7eb', 'border-radius: 10px',
          'color: #e5e7eb', 'font: bold 22px/1 "Courier New", monospace',
          'letter-spacing: 1px', 'direction: ltr', 'unicode-bidi: plaintext',
          'pointer-events: none', 'z-index: 2147483647',
          'box-shadow: 0 2px 12px rgba(0,0,0,0.4)'
        ].join(';');
        document.body.appendChild(el);
      }
      var ms, color;
      if (state === 'running') {
        var start = parseInt(sessionStorage.getItem('__sc_timer_start') || '0', 10);
        ms = start ? Date.now() - start : 0;
        color = '#e5e7eb';
      } else {
        ms = parseInt(sessionStorage.getItem('__sc_timer_final') || '0', 10);
        var thr = parseInt(sessionStorage.getItem('__sc_timer_threshold') || '3000', 10);
        color = ms <= thr ? '#22c55e' : '#ef4444';
      }
      var label = sessionStorage.getItem('__sc_timer_label') || '';
      el.style.borderColor = color;
      el.style.color = color;
      el.textContent = (label ? label + '  ' : '') + (ms / 1000).toFixed(2) + 's';
    } catch (e) { /* cosmetics only */ }
  }
  function loop() { render(); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
})();
`;

/** Arm the stopwatch ticker on the current page and every future navigation. */
export async function installStopwatch(page: Page): Promise<void> {
  try {
    await page.context().addInitScript(STOPWATCH_INIT_SCRIPT); // future documents
    await page.evaluate(STOPWATCH_INIT_SCRIPT);                 // current document
  } catch { /* cosmetics only */ }
}

/** Begin counting (call immediately before the timed click/navigation). */
export async function startStopwatch(
  page: Page,
  opts?: { label?: string; thresholdMs?: number },
): Promise<void> {
  const label = opts?.label ?? '';
  const thresholdMs = opts?.thresholdMs ?? 3000;
  try {
    await page.evaluate(
      ({ label, thresholdMs }: { label: string; thresholdMs: number }) => {
        sessionStorage.setItem('__sc_timer_start', String(Date.now()));
        sessionStorage.setItem('__sc_timer_state', 'running');
        sessionStorage.setItem('__sc_timer_label', label);
        sessionStorage.setItem('__sc_timer_threshold', String(thresholdMs));
        sessionStorage.removeItem('__sc_timer_final');
      },
      { label, thresholdMs },
    );
  } catch { /* cosmetics only */ }
}

/** Freeze the timer at `finalMs` (green if ≤ threshold, red otherwise). */
export async function stopStopwatch(page: Page, finalMs: number): Promise<void> {
  try {
    await page.evaluate((ms: number) => {
      sessionStorage.setItem('__sc_timer_final', String(Math.max(0, Math.round(ms))));
      sessionStorage.setItem('__sc_timer_state', 'stopped');
    }, finalMs);
  } catch { /* cosmetics only */ }
}

/** Remove the timer overlay entirely. */
export async function hideStopwatch(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      ['__sc_timer_state', '__sc_timer_start', '__sc_timer_final', '__sc_timer_label', '__sc_timer_threshold']
        .forEach((k) => sessionStorage.removeItem(k));
      document.getElementById('__sitecheck_timer')?.remove();
    });
  } catch { /* cosmetics only */ }
}

// ────────────────────────────────────────────────────────────
//  Title-card overlay (Pillar 7 — clean-case closing card)
//
//  A full-viewport card shown in-stream at the end of a clean run, e.g.
//  "No bugs, glitches, or broken links detected". Styled to match the Video
//  Journey title cards (lib/video-journey.ts). Best-effort cosmetics.
// ────────────────────────────────────────────────────────────
const TITLE_CARD_ELEMENT_ID = '__sitecheck_titlecard';

/** Show a full-screen title card with the given (single-line) text. */
export async function showTitleCard(page: Page, text: string): Promise<void> {
  try {
    await page.evaluate(
      ({ text, id }: { text: string; id: string }) => {
        if (!document.body) return;
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          el.style.cssText = [
            'position: fixed', 'inset: 0',
            'background: radial-gradient(circle at 50% 35%, #12315c 0%, #0b1220 70%)',
            'display: flex', 'align-items: center', 'justify-content: center',
            'padding: 6vw', 'text-align: center',
            'color: #ffffff', 'font: bold 40px/1.35 Arial, sans-serif',
            'direction: ltr', 'unicode-bidi: plaintext',
            'pointer-events: none', 'z-index: 2147483647',
          ].join(';');
          document.body.appendChild(el);
        }
        el.textContent = text;
      },
      { text, id: TITLE_CARD_ELEMENT_ID },
    );
  } catch { /* cosmetics only */ }
}

/** Remove the title card. */
export async function hideTitleCard(page: Page): Promise<void> {
  try {
    await page.evaluate((id: string) => document.getElementById(id)?.remove(), TITLE_CARD_ELEMENT_ID);
  } catch { /* cosmetics only */ }
}

// ────────────────────────────────────────────────────────────
//  Security panel overlay (Pillar 8 — Q36 secure-connection proof)
//
//  Playwright's recordVideo captures only the page viewport, NOT the browser
//  chrome — so the address-bar padlock and its native popup can never appear on
//  video. This overlay is the substitute: an on-page card showing the REAL TLS
//  handshake data (from response.securityDetails()). Green when secure, red when
//  not. Best-effort cosmetics.
// ────────────────────────────────────────────────────────────
const SECURITY_PANEL_ELEMENT_ID = '__sitecheck_secpanel';

export interface SecurityPanelDetails {
  url: string;
  secure: boolean;
  issuer?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  protocol?: string | null;
  note?: string | null;
}

/** Show the on-page connection-security card with real certificate data. */
export async function showSecurityPanel(page: Page, details: SecurityPanelDetails): Promise<void> {
  try {
    await page.evaluate(
      ({ d, id }: { d: SecurityPanelDetails; id: string }) => {
        if (!document.body) return;
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          document.body.appendChild(el);
        }
        const accent = d.secure ? '#22c55e' : '#ef4444';
        el.style.cssText = [
          'position: fixed', 'top: 20px', 'left: 50%', 'transform: translateX(-50%)',
          'min-width: 440px', 'max-width: 620px', 'padding: 16px 22px',
          'background: rgba(15, 23, 42, 0.96)', `border: 2px solid ${accent}`,
          'border-radius: 12px', 'color: #e5e7eb',
          'font: 15px/1.6 Arial, sans-serif', 'direction: ltr', 'unicode-bidi: plaintext',
          'pointer-events: none', 'z-index: 2147483647',
          'box-shadow: 0 8px 30px rgba(0,0,0,0.5)',
        ].join(';');
        const rows: string[] = [];
        rows.push(`<div style="font-weight:bold;font-size:18px;color:${accent};margin-bottom:8px">`
          + `${d.secure ? '🔒  Connection is secure' : '⚠️  Connection is NOT secure'}</div>`);
        rows.push(`<div style="word-break:break-all;color:#93c5fd;margin-bottom:6px">${d.url || ''}</div>`);
        if (d.issuer) rows.push(`<div>Certificate: <b>${d.issuer}</b></div>`);
        if (d.validFrom || d.validTo) rows.push(`<div>Valid: ${d.validFrom || '?'} → ${d.validTo || '?'}</div>`);
        if (d.protocol) rows.push(`<div>${d.protocol}</div>`);
        if (d.note) rows.push(`<div style="color:#fca5a5;margin-top:4px">${d.note}</div>`);
        rows.push('<div style="margin-top:8px;font-size:12px;color:#94a3b8">— verified by SiteCheck —</div>');
        el.innerHTML = rows.join('');
      },
      { d: details, id: SECURITY_PANEL_ELEMENT_ID },
    );
  } catch { /* cosmetics only */ }
}

/** Remove the security panel. */
export async function hideSecurityPanel(page: Page): Promise<void> {
  try {
    await page.evaluate((id: string) => document.getElementById(id)?.remove(), SECURITY_PANEL_ELEMENT_ID);
  } catch { /* cosmetics only */ }
}
