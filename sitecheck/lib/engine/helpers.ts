// lib/engine/helpers.ts — Shared navigation helpers for pillar checks
import type { Page } from 'playwright';

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
