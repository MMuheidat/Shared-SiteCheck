// lib/engine/helpers.ts — Shared navigation helpers for pillar checks
import type { Page } from 'playwright';
import { clickWithHighlight, type EvidenceRecorder } from '@/lib/engine/recording';

/**
 * Hamburger / 3-dash menu buttons. Deliberately tag-agnostic: some sites use
 * a <label> (e.g. ADMO's `label.menuburger`) or a <div>, not a <button>.
 */
export const BURGER_MENU_SELECTORS = [
  '[class*="burger"]', '[class*="hamburger"]',
  '[class*="menu-toggle"]', '[class*="nav-toggle"]', '[class*="navbar-toggler"]',
  'button[aria-label*="menu" i]', '[aria-label*="القائمة"]',
  'label[class*="menu"]', '[id*="menu-toggle"]', '[class*="menu-btn"]', '[class*="menu-icon"]',
];

/** Count same-origin links a human could actually click (visible in viewport). */
async function countViewportNavLinks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const orig = location.origin;
    let n = 0;
    for (const a of document.querySelectorAll('a[href]')) {
      const href = (a as HTMLAnchorElement).href;
      if (!href.startsWith(orig) || href === orig + '/' || href.includes('#')) continue;
      const r = a.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight &&
          r.left >= 0 && r.right <= window.innerWidth) n++;
    }
    return n;
  }).catch(() => 0);
}

/**
 * Open the site's hamburger navigation menu, if one exists: find a small
 * burger-like control near the top of the page, click it (with a highlight
 * hold so recordings show the deliberate action), and confirm the menu
 * actually opened by checking that more nav links became clickable.
 * Best-effort — returns false on any failure, never throws.
 */
export async function openNavMenu(
  page: Page,
  opts?: { holdMs?: number },
): Promise<boolean> {
  const holdMs = opts?.holdMs ?? 100;
  try {
    for (const sel of BURGER_MENU_SELECTORS) {
      const loc = page.locator(sel).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      const box = await loc.boundingBox().catch(() => null);
      // Small control in the top region of the page (headers), not footer links
      if (!box || box.width < 12 || box.height < 8 || box.width > 100 || box.height > 100) continue;
      if (box.y > 250) continue;

      const before = await countViewportNavLinks(page);
      await clickWithHighlight(loc, { holdMs, timeout: 4000 });
      await page.waitForTimeout(1200);
      const after = await countViewportNavLinks(page);
      if (after > before) return true;
      // Clicked something that didn't reveal nav — close it and stop guessing
      try { await page.keyboard.press('Escape'); } catch { /* */ }
      return false;
    }
  } catch { /* cosmetics + navigation aid only */ }
  return false;
}

/**
 * Navigate to a URL and wait for the page to fully render.
 * Uses networkidle with fallback to domcontentloaded, plus a stabilization delay.
 */
export async function navigateAndWait(
  page: Page,
  url: string,
  options?: { timeout?: number; waitAfter?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 30000;
  const waitAfter = options?.waitAfter ?? 3000;

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout });
  } catch {
    // Fallback to domcontentloaded if networkidle times out
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {
      // Last resort — just commit
      await page.goto(url, { waitUntil: 'commit', timeout: 10000 });
    }
  }

  // Extra stabilization for JS-rendered SPAs
  await page.waitForTimeout(waitAfter);
}

/**
 * Take a screenshot after ensuring the page content is visible.
 * Waits for body to be non-empty and a short stabilization period.
 */
export async function takeScreenshot(
  page: Page,
  absPath: string,
  options?: { fullPage?: boolean; waitMs?: number }
): Promise<void> {
  // Wait briefly for any pending renders
  await page.waitForTimeout(options?.waitMs ?? 1000);
  await page.screenshot({ path: absPath, fullPage: options?.fullPage ?? false });
}

/**
 * Try to capture a screenshot of the first matching element from a list of selectors.
 * Falls back to a normal page screenshot when no element match is found.
 * NOTE: Prefer takeHighlightedScreenshot where full context is needed.
 */
export async function takeElementScreenshot(
  page: Page,
  absPath: string,
  selectors: string[],
  options?: { fallbackFullPage?: boolean; padding?: number }
): Promise<boolean> {
  await page.waitForTimeout(1000);
  const padding = Math.max(10, Math.min(options?.padding ?? 24, 50));

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      try {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (box) {
          const viewport = page.viewportSize();
          const clip = {
            x: Math.max(0, box.x - padding),
            y: Math.max(0, box.y - padding),
            width: Math.max(1, box.width + padding * 2),
            height: Math.max(1, box.height + padding * 2),
          };

          if (viewport) {
            clip.width = Math.min(clip.width, viewport.width - clip.x);
            clip.height = Math.min(clip.height, viewport.height - clip.y);
          }

          await page.screenshot({ path: absPath, clip });
          return true;
        }

        await locator.screenshot({ path: absPath });
        return true;
      } catch {
        // Try the next selector.
      }
    }
  }

  await page.screenshot({ path: absPath, fullPage: options?.fallbackFullPage ?? false });
  return false;
}

/**
 * Dismiss cookie consent banners so they don't cover evidence screenshots.
 * Tries clicking common accept/decline buttons first, then hides any
 * remaining overlay elements. Best-effort — never throws.
 */
export async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    const cookieButtonSelectors = [
      'button:has-text("Accept All")', 'button:has-text("Accept all")',
      'button:has-text("ACCEPT ALL COOKIES")', 'button:has-text("Accept all cookies")',
      'button:has-text("Accept Cookies")', 'button:has-text("Accept cookies")',
      'button:has-text("Accept")',
      'button:has-text("Allow All")', 'button:has-text("Allow all")',
      'button:has-text("Agree")', 'button:has-text("I agree")',
      'button:has-text("Got it")', 'button:has-text("OK")',
      'button:has-text("Decline")', 'button:has-text("Decline Cookies")',
      'button:has-text("DECLINE COOKIES")',
      'button:has-text("Reject All")', 'button:has-text("Reject all")',
      'button:has-text("موافق")', 'button:has-text("قبول")',
      'a:has-text("Accept All")', 'a:has-text("Accept all cookies")',
      '[id*="cookie"] button', '[class*="cookie"] button',
      '[id*="consent"] button', '[class*="consent"] button',
      '[id*="gdpr"] button', '[class*="gdpr"] button',
      '#onetrust-accept-btn-handler', '.onetrust-close-btn-handler',
      '[data-testid="cookie-accept"]', '[data-testid="accept-cookies"]',
    ];

    for (const sel of cookieButtonSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 1000 });
          console.log(`[SiteCheck] Dismissed cookie banner via: ${sel}`);
          await page.waitForTimeout(1000);
          return;
        }
      } catch { /* try next */ }
    }

    // Fallback: hide cookie overlay elements that are still visible
    await page.evaluate(() => {
      const overlaySelectors = [
        '[id*="cookie"]', '[class*="cookie-banner"]', '[class*="cookie-consent"]',
        '[class*="cookie-notice"]', '[class*="cookie-popup"]', '[class*="cookie-overlay"]',
        '[class*="cookie-bar"]', '[class*="cookiebar"]',
        '[id*="consent"]', '[class*="consent-banner"]', '[class*="consent-modal"]',
        '[id*="gdpr"]', '[class*="gdpr"]',
        '#onetrust-banner-sdk', '#onetrust-consent-sdk',
        '[class*="CookieConsent"]', '[class*="cookieConsent"]',
      ];
      for (const sel of overlaySelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const rect = (el as HTMLElement).getBoundingClientRect();
            if (rect.width > 100 && rect.height > 50) {
              (el as HTMLElement).style.display = 'none';
            }
          }
        } catch { /* */ }
      }
    });
  } catch {
    // Cookie dismissal is best-effort
  }
}

/**
 * Capture a screenshot with a DRAWN red rectangle (fixed-position overlay div)
 * around the target element, plus an optional red label pill above it.
 *
 * Unlike takeHighlightedScreenshot (which styles the element's own outline and
 * can be defeated by site CSS or hug a tiny inline anchor), the overlay box is
 * always visible and — with `containerize` — wraps the element's whole result
 * card, not just the link text. The overlay is removed after the shot (it is
 * position:fixed and must not survive later scrolling).
 *
 * Returns true if a box was drawn, false if it fell back to a plain screenshot.
 */
export async function takeBoxedScreenshot(
  page: Page,
  absPath: string,
  selectors: string[],
  options?: { label?: string; containerize?: boolean; padding?: number; waitMs?: number }
): Promise<boolean> {
  const padding = options?.padding ?? 8;
  await page.waitForTimeout(options?.waitMs ?? 400);

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) === 0 || !(await locator.isVisible())) continue;
      await locator.scrollIntoViewIfNeeded();

      const drawn = await locator.evaluate(
        (el: Element, args: { label?: string; containerize?: boolean; padding: number }) => {
          // Optionally climb to the ancestor that represents the whole result card
          let target: Element = el;
          if (args.containerize) {
            const vh = window.innerHeight;
            let current: Element | null = el;
            while (current && current !== document.body) {
              const r = current.getBoundingClientRect();
              if (r.width >= 350 && r.height >= 50) {
                if (r.height > vh * 0.6) break; // too big — keep the previous target
                target = current;
                break;
              }
              current = current.parentElement;
            }
          }

          const rect = target.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;

          const box = document.createElement('div');
          box.id = '__sitecheck_box';
          box.style.cssText = [
            'position: fixed',
            `left: ${rect.left - args.padding}px`,
            `top: ${rect.top - args.padding}px`,
            `width: ${rect.width + args.padding * 2}px`,
            `height: ${rect.height + args.padding * 2}px`,
            'border: 4px solid red',
            'border-radius: 6px',
            'box-shadow: 0 0 15px rgba(255, 0, 0, 0.5)',
            'pointer-events: none',
            'z-index: 2147483647',
          ].join(';');
          document.body.appendChild(box);

          if (args.label) {
            const pill = document.createElement('div');
            pill.id = '__sitecheck_box_label';
            pill.textContent = args.label;
            pill.style.cssText = [
              'position: fixed',
              'background: red',
              'color: white',
              'padding: 4px 10px',
              'font: bold 14px/1.3 Arial, sans-serif',
              'border-radius: 4px',
              'pointer-events: none',
              'z-index: 2147483647',
              'white-space: nowrap',
            ].join(';');
            document.body.appendChild(pill);
            const pillRect = pill.getBoundingClientRect();
            // Above the box; below it when there is no room
            let top = rect.top - args.padding - pillRect.height - 6;
            if (top < 4) top = rect.bottom + args.padding + 6;
            let left = rect.left - args.padding;
            if (left + pillRect.width > window.innerWidth - 8) {
              left = window.innerWidth - pillRect.width - 8;
            }
            if (left < 4) left = 4;
            pill.style.top = `${top}px`;
            pill.style.left = `${left}px`;
          }
          return true;
        },
        { label: options?.label, containerize: options?.containerize, padding },
      );

      if (!drawn) continue;

      await page.waitForTimeout(400); // visible on the recording
      await page.screenshot({ path: absPath });

      await page.evaluate(() => {
        document.getElementById('__sitecheck_box')?.remove();
        document.getElementById('__sitecheck_box_label')?.remove();
      }).catch(() => { /* page may have navigated */ });

      return true;
    } catch {
      // Try the next selector.
    }
  }

  await page.screenshot({ path: absPath });
  return false;
}

/**
 * Capture a full-page or large-viewport screenshot with a visible red highlight box
 * around the target element. Does NOT crop the image, ensuring surrounding context
 * (like headers and layout) is preserved.
 */
export async function takeHighlightedScreenshot(
  page: Page,
  absPath: string,
  selectors: string[],
  options?: { fullPage?: boolean; label?: string; contextualZoom?: boolean; maxHighlightBox?: { width: number, height: number }; waitMs?: number }
): Promise<boolean> {
  await page.waitForTimeout(options?.waitMs ?? 1000);
  let highlighted = false;

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && await locator.isVisible()) {
      try {
        const box = await locator.boundingBox();
        
        // Skip elements that are too large (e.g. full page wrappers or generic headers)
        if (box && options?.maxHighlightBox) {
          if (box.width > options.maxHighlightBox.width || box.height > options.maxHighlightBox.height) {
            continue; // Try next selector
          }
        }

        await locator.scrollIntoViewIfNeeded();
        
        // Inject a visible highlight using evaluation
        await locator.evaluate((el: Element, labelText?: string) => {
          const htmlEl = el as HTMLElement;
          htmlEl.dataset.origOutline = htmlEl.style.outline;
          htmlEl.dataset.origOutlineOffset = htmlEl.style.outlineOffset;
          htmlEl.dataset.origBoxShadow = htmlEl.style.boxShadow;
          
          htmlEl.style.outline = '4px solid red';
          htmlEl.style.outlineOffset = '2px';
          htmlEl.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';
          htmlEl.style.transition = 'none'; // Ensure instant apply
          
          if (labelText) {
            const labelEl = document.createElement('div');
            labelEl.textContent = labelText;
            labelEl.style.position = 'absolute';
            labelEl.style.backgroundColor = 'red';
            labelEl.style.color = 'white';
            labelEl.style.padding = '4px 8px';
            labelEl.style.fontSize = '14px';
            labelEl.style.fontWeight = 'bold';
            labelEl.style.borderRadius = '4px';
            labelEl.style.zIndex = '999999';
            labelEl.style.pointerEvents = 'none';
            
            labelEl.id = 'sitecheck-highlight-label';
            document.body.appendChild(labelEl);

            const rect = htmlEl.getBoundingClientRect();
            const labelRect = labelEl.getBoundingClientRect();
            
            // Try placing above the element
            let top = rect.top + window.scrollY - labelRect.height - 8;
            let left = rect.left + window.scrollX;
            
            // If there's not enough space above, place it below the element
            if (rect.top < labelRect.height + 10) {
              top = rect.bottom + window.scrollY + 8;
            }
            
            // Prevent clipping on the right edge
            if (rect.left + labelRect.width > window.innerWidth) {
              left = window.innerWidth + window.scrollX - labelRect.width - 8;
            }
            
            // Prevent clipping on the left edge
            if (rect.left < 0) {
              left = window.scrollX + 8;
            }
            
            labelEl.style.top = `${top}px`;
            labelEl.style.left = `${left}px`;
          }
        }, options?.label);
        
        await page.waitForTimeout(500);

        let clip = undefined;
        let useFullPage = options?.fullPage ?? false;

        // If contextualZoom is true, capture the full width of the screen but limit height
        // to show the element with some vertical context (e.g., the header).
        if (options?.contextualZoom) {
          const box = await locator.boundingBox();
          const viewport = page.viewportSize();
          if (box && viewport) {
            useFullPage = false; // mutually exclusive with clip
            const paddingVertical = 150;
            const yStart = Math.max(0, box.y - paddingVertical);
            const neededHeight = (box.y - yStart) + box.height + paddingVertical;
            clip = {
              x: 0,
              y: yStart,
              width: viewport.width,
              height: Math.min(viewport.height, Math.max(neededHeight, 350))
            };
          }
        }
        
        await page.screenshot({ path: absPath, fullPage: useFullPage, clip });
        
        // Cleanup label if it was added
        if (options?.label) {
          await page.evaluate(() => {
            const label = document.getElementById('sitecheck-highlight-label');
            if (label) label.remove();
          });
        }
        
        highlighted = true;
        return true;
      } catch {
        // Try next selector on failure
      }
    }
  }

  // Fallback if no element could be highlighted
  if (!highlighted) {
    let clip = undefined;
    let useFullPage = options?.fullPage ?? false;
    if (options?.contextualZoom) {
      const viewport = page.viewportSize();
      if (viewport) {
        useFullPage = false;
        clip = {
          x: 0,
          y: 0,
          width: viewport.width,
          height: Math.min(viewport.height, 400)
        };
      }
    }
    await page.screenshot({ path: absPath, fullPage: useFullPage, clip });
  }
  return false;
}

export interface HighlightTarget {
  /** CSS selector; ALL visible matches are highlighted (unlike takeHighlightedScreenshot). */
  selector: string;
  /** Red label pill placed near the FIRST match of this selector. */
  label?: string;
}

/**
 * Outline every visible element matched by the targets (deduped across
 * selectors), scroll the densest vertical cluster of matches into view, and
 * place label pills. Elements larger than maxBox are skipped so container
 * wrappers (whole footers/navs) never swallow the individual highlights.
 * Elements are tagged data-sitecheck-multi for clearHighlights.
 * Best-effort — returns the number highlighted, never throws.
 */
export async function highlightElements(
  page: Page,
  targets: HighlightTarget[],
  opts?: {
    maxTotal?: number;
    maxBox?: { width: number; height: number };
    scrollToCluster?: boolean;
  },
): Promise<number> {
  try {
    return await page.evaluate(
      (args: {
        targets: { selector: string; label?: string }[];
        maxTotal: number;
        maxBox: { width: number; height: number };
        scrollToCluster: boolean;
      }) => {
        const picked: { el: HTMLElement; label?: string }[] = [];
        const seen = new Set<Element>();
        for (const t of args.targets) {
          let matches: Element[] = [];
          try { matches = Array.from(document.querySelectorAll(t.selector)); } catch { continue; }
          let firstOfSelector = true;
          for (const el of matches) {
            if (seen.has(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            if (r.width > args.maxBox.width || r.height > args.maxBox.height) continue;
            // Horizontally off-canvas (closed drawer) elements have a box but a
            // human can't see them — skip. Vertical off-viewport is fine (we scroll).
            if (r.right <= 0 || r.left >= window.innerWidth) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
            seen.add(el);
            picked.push({ el: el as HTMLElement, label: firstOfSelector ? t.label : undefined });
            firstOfSelector = false;
            if (picked.length >= args.maxTotal) break;
          }
          if (picked.length >= args.maxTotal) break;
        }
        if (picked.length === 0) return 0;

        // Scroll the viewport-height window containing the most matches into
        // view (social icon rows usually live in the footer).
        if (args.scrollToCluster) {
          const ys = picked.map(p => p.el.getBoundingClientRect().top + window.scrollY);
          const vh = window.innerHeight;
          let bestTop = Math.max(0, Math.min(...ys) - 120);
          let bestCount = -1;
          for (const y of ys) {
            const winTop = Math.max(0, y - 120);
            const count = ys.filter(v => v >= winTop && v <= winTop + vh - 160).length;
            if (count > bestCount) { bestCount = count; bestTop = winTop; }
          }
          window.scrollTo(0, bestTop);
        }

        for (const p of picked) {
          const el = p.el;
          el.dataset.sitecheckMultiOutline = el.style.outline;
          el.dataset.sitecheckMultiOffset = el.style.outlineOffset;
          el.dataset.sitecheckMultiShadow = el.style.boxShadow;
          el.dataset.sitecheckMulti = '1';
          // The label pill is created later (settleHighlightsAndPlaceLabels):
          // infinite-feed pages hijack the scroll position when new content
          // loads, so pills placed now would anchor to stale coordinates.
          if (p.label) el.dataset.sitecheckMultiLabel = p.label;
          el.style.outline = '4px solid red';
          el.style.outlineOffset = '2px';
          el.style.boxShadow = '0 0 15px rgba(255, 0, 0, 0.5)';
          el.style.transition = 'none';
        }
        return picked.length;
      },
      {
        targets,
        maxTotal: opts?.maxTotal ?? 12,
        maxBox: opts?.maxBox ?? { width: 600, height: 300 },
        scrollToCluster: opts?.scrollToCluster ?? true,
      },
    );
  } catch {
    return 0; // evidence cosmetics never fail a criterion
  }
}

/** Undo highlightElements: restore saved styles, remove label pills. */
export async function clearHighlights(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-sitecheck-multi]'))) {
        const h = el as HTMLElement;
        h.style.outline = h.dataset.sitecheckMultiOutline || '';
        h.style.outlineOffset = h.dataset.sitecheckMultiOffset || '';
        h.style.boxShadow = h.dataset.sitecheckMultiShadow || '';
        delete h.dataset.sitecheckMulti;
        delete h.dataset.sitecheckMultiOutline;
        delete h.dataset.sitecheckMultiOffset;
        delete h.dataset.sitecheckMultiShadow;
        delete h.dataset.sitecheckMultiLabel;
      }
      for (const pill of Array.from(document.querySelectorAll('.__sitecheck_multi_label'))) pill.remove();
    });
  } catch { /* page may have navigated away */ }
}

/**
 * Make sure at least one highlighted element is actually inside the viewport
 * (infinite-feed pages insert content when scrolled, which moves the target
 * away — e.g. ADMO's footer), then create the label pills at the settled
 * coordinates. Best-effort, never throws.
 */
async function settleHighlightsAndPlaceLabels(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const inView = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-sitecheck-multi]'));
      if (els.length === 0) return true;
      const visible = els.some(el => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      });
      if (!visible) {
        const r = els[0].getBoundingClientRect();
        window.scrollTo(0, Math.max(0, r.top + window.scrollY - Math.floor(window.innerHeight / 3)));
      }
      return visible;
    }).catch(() => true);
    if (inView) break;
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => {
    // Idempotent: drop stale pills so a re-settle pass can re-place them.
    for (const pill of Array.from(document.querySelectorAll('.__sitecheck_multi_label'))) pill.remove();
    for (const el of Array.from(document.querySelectorAll('[data-sitecheck-multi]'))) {
      const label = (el as HTMLElement).dataset.sitecheckMultiLabel;
      if (!label) continue;
      const rect = el.getBoundingClientRect();
      const pill = document.createElement('div');
      pill.textContent = label;
      pill.className = '__sitecheck_multi_label';
      pill.style.cssText =
        'position:absolute;background:red;color:white;padding:4px 8px;' +
        'font:bold 14px/1.3 Arial,sans-serif;border-radius:4px;' +
        'pointer-events:none;z-index:2147483647;white-space:nowrap;';
      document.body.appendChild(pill);
      const pr = pill.getBoundingClientRect();
      let top = rect.top + window.scrollY - pr.height - 8;
      if (rect.top < pr.height + 10) top = rect.bottom + window.scrollY + 8;
      let left = rect.left + window.scrollX;
      if (rect.left + pr.width > window.innerWidth) {
        left = window.innerWidth + window.scrollX - pr.width - 8;
      }
      if (left < window.scrollX + 4) left = window.scrollX + 4;
      pill.style.top = `${top}px`;
      pill.style.left = `${left}px`;
    }
  }).catch(() => { /* best-effort */ });
}

/**
 * highlightElements → hold (visible on recordings) → viewport screenshot
 * (height capped at 800px) → clearHighlights (unless keepHighlights).
 * Zero matches still produce a plain viewport shot so evidence is never blank.
 * Returns the highlight count.
 */
export async function takeMultiHighlightScreenshot(
  page: Page,
  absPath: string,
  targets: HighlightTarget[],
  opts?: {
    holdMs?: number;
    maxTotal?: number;
    maxBox?: { width: number; height: number };
    keepHighlights?: boolean;
    scrollToCluster?: boolean;
  },
): Promise<number> {
  const count = await highlightElements(page, targets, {
    maxTotal: opts?.maxTotal,
    maxBox: opts?.maxBox,
    scrollToCluster: opts?.scrollToCluster,
  });
  if (count > 0) await settleHighlightsAndPlaceLabels(page);
  await page.waitForTimeout(opts?.holdMs ?? 400);
  // Infinite-feed pages can insert content DURING the hold and push the
  // highlighted cluster out of view again — re-settle right before the shot.
  if (count > 0) await settleHighlightsAndPlaceLabels(page);
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
  } catch { /* best-effort evidence */ }
  if (!opts?.keepHighlights) await clearHighlights(page);
  return count;
}

/**
 * Click the on-page anchor for href like a human visitor would. Re-opens the
 * burger menu when the anchor is hidden, forces same-tab navigation (menu
 * links sometimes open new tabs, which would not appear on the recorded
 * page's video), and falls back to a direct goto when clicking isn't possible.
 * Shared version of the pattern used by pillars 2 and 3.
 */
export async function humanNavigate(page: Page, href: string, recorder?: EvidenceRecorder): Promise<void> {
  try {
    const u = new URL(href);
    const sel = `a[href="${href}"], a[href="${u.pathname + u.search}"]`;
    let anchor = page.locator(sel).first();
    if (!(await anchor.isVisible().catch(() => false))) {
      await openNavMenu(page, { holdMs: recorder ? 1000 : 100 });
      anchor = page.locator(sel).first();
    }
    if (await anchor.isVisible().catch(() => false)) {
      await anchor.evaluate(el => { (el as HTMLAnchorElement).target = '_self'; }).catch(() => {});
      await clickWithHighlight(anchor, { holdMs: recorder ? 1000 : 300, timeout: 5000 });
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* */ }
      await page.waitForTimeout(1500);
      return;
    }
  } catch { /* fall through to direct navigation */ }
  await navigateAndWait(page, href);
}
