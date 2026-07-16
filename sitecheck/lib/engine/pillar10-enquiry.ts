// lib/engine/pillar10-enquiry.ts — Enquiry Form Journey (Pillar 10)
//
// Phase A (this file, synchronous, browser):
//   Q53 — enquiry form available (non-scored). If none anywhere → the pillar
//         scores 0 and stops (no channel to evaluate).
//   Q54 — fill name + email + enquiry message (phone left empty) and, when
//         SITECHECK_ENQUIRY_SUBMIT=1, actually submit. [2/0]
//   Q55 — thank-you message on the real post-submit page. [1/0]
//   On a confirmed submit, a PendingEnquiry row is written and Q56–Q66 are
//   emitted as `pending` — the background poller (scripts/poll-enquiries.ts)
//   grades those from the auto-reply + personalized email reply later.
//
// Submitting messages a real inbox, so the submit click is gated behind
// SITECHECK_ENQUIRY_SUBMIT=1 (off by default). When off, the form is filled and
// screenshotted but not sent, and the reply tail is emitted as `na` (deferred).
// Kept generic across any entity site per [[engine-must-generalize]].

import type { Page } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeElementScreenshot, dismissCookieBanner } from '@/lib/engine/helpers';
import { prisma } from '@/lib/prisma';
import {
  SUBMIT_ENQUIRY, TEST_NAME, TEST_EMAIL, TEST_SUBJECT, ENQUIRY_MESSAGE,
  REPLY_QIDS, addBusinessDays, hostOf,
} from '@/lib/engine/enquiry-shared';

const PILLAR = 'Enquiry Form Journey';

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
  return {
    rel: `/screenshots/${auditJobId}/q${qid}.png`,
    abs: path.join(process.cwd(), 'public', 'screenshots', auditJobId, `q${qid}.png`),
  };
}

async function viewportShot(page: Page, absPath: string): Promise<void> {
  const vp = page.viewportSize();
  if (vp) {
    await page.screenshot({ path: absPath, clip: { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, 800) } }).catch(() => {});
  } else {
    await page.screenshot({ path: absPath }).catch(() => {});
  }
}

// Emit the whole reply-dependent tail (Q56–Q66) in one of three modes:
//   'zero'    — no form / not submitted: scored → fail 0, non-scored → na
//   'na'      — deferred (gated off / CAPTCHA / submit failed)
//   'pending' — submitted, awaiting the email reply (poller will resolve)
function replyTail(mode: 'zero' | 'na' | 'pending', note: string): CriterionResult[] {
  return REPLY_QIDS.map((qid) => {
    const def = getCriterion(qid)!;
    const nonScored = def.maxScore === 0;
    let status: CriterionResult['status'];
    if (mode === 'pending') status = 'pending';
    else if (mode === 'na') status = 'na';
    else status = nonScored ? 'na' : 'fail';
    return makeResult(qid, {
      status,
      scoreEarned: 0,
      notes: note,
      recommendation: mode === 'zero' && !nonScored ? getRecommendation(qid) : '',
    });
  });
}

// ────────────────────────────────────────────────────────────
//  Q53 — Enquiry form available (non-scored)
// ────────────────────────────────────────────────────────────
interface FormInfo { found: boolean; formUrl: string | null; fieldCount: number; hasSubmitButton: boolean }

const CONTACT_LINK_SELECTORS = [
  'a[href*="contact" i]', 'a[href*="enquir" i]', 'a[href*="inquiry" i]', 'a[href*="feedback" i]',
  'a[href*="اتصل"]', 'a[href*="تواصل"]', 'a[href*="استفسار"]',
];

function scanForm(): FormInfo {
  const forms = Array.from(document.querySelectorAll('form'));
  for (const form of forms) {
    const inputs = form.querySelectorAll('input:not([type="hidden"]), textarea, select');
    const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (inputs.length >= 2 && (submit || form.querySelector('textarea'))) {
      return { found: true, formUrl: window.location.href, fieldCount: inputs.length, hasSubmitButton: !!submit };
    }
  }
  return { found: false, formUrl: null, fieldCount: 0, hasSubmitButton: false };
}

async function checkQ53(page: Page, auditJobId: string): Promise<{ result: CriterionResult; formInfo: FormInfo }> {
  const empty: FormInfo = { found: false, formUrl: null, fieldCount: 0, hasSubmitButton: false };
  try {
    let formInfo = await page.evaluate(scanForm);

    // If no form on the landing page, follow a contact/enquiry link and re-scan.
    if (!formInfo.found) {
      const link = await page.evaluate((sels) => {
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel) as HTMLAnchorElement | null;
            if (el?.href) return el.href;
          } catch { /* */ }
        }
        return null;
      }, CONTACT_LINK_SELECTORS);
      if (link) {
        try {
          await navigateAndWait(page, link);
          await dismissCookieBanner(page);
          formInfo = await page.evaluate(scanForm);
        } catch { /* navigation failed */ }
      }
    }

    const ss = ssPath(auditJobId, '53');
    await takeElementScreenshot(page, ss.abs, [
      'form', 'textarea', 'input[name*="email" i]', 'button[type="submit"]', 'input[type="submit"]',
    ]);

    const result = makeResult('Q53', {
      scoreEarned: 0,
      status: formInfo.found ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: formInfo.found
        ? `Enquiry/contact form found with ${formInfo.fieldCount} field(s)${formInfo.formUrl ? ` at ${formInfo.formUrl}` : ''}.`
        : 'No enquiry or contact form detected anywhere on the site.',
      recommendation: formInfo.found ? '' : getRecommendation('Q53'),
    });
    return { result, formInfo };
  } catch (err) {
    return {
      result: makeResult('Q53', { status: 'fail', notes: `Error: ${err instanceof Error ? err.message : String(err)}` }),
      formInfo: empty,
    };
  }
}

// ────────────────────────────────────────────────────────────
//  Field detection + tagging (runs in page.evaluate)
// ────────────────────────────────────────────────────────────
interface FieldDesc { tag: string; kind: string; tagName: string; required: boolean }
interface TagResult { found: boolean; fields: FieldDesc[]; hasSubmit: boolean; hasCaptcha: boolean; formAction: string }

function detectAndTagFields(): TagResult {
  const FILLABLE = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select';
  const forms = Array.from(document.querySelectorAll('form'));
  let target: HTMLFormElement | null = null;
  for (const f of forms) {
    if (f.querySelectorAll(FILLABLE).length >= 2 && f.querySelector('textarea')) { target = f; break; }
  }
  if (!target) {
    for (const f of forms) {
      const submit = f.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (f.querySelectorAll(FILLABLE).length >= 2 && submit) { target = f; break; }
    }
  }
  if (!target) return { found: false, fields: [], hasSubmit: false, hasCaptcha: false, formAction: '' };

  const labelText = (el: Element): string => {
    let t = '';
    const id = el.getAttribute('id');
    if (id) { const l = document.querySelector(`label[for="${id}"]`); if (l) t += ' ' + (l.textContent || ''); }
    const wrap = el.closest('label'); if (wrap) t += ' ' + (wrap.textContent || '');
    return t.toLowerCase();
  };
  const kindOf = (el: Element): string => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'TEXTAREA') return 'message';
    const hay = [
      el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('placeholder'),
      el.getAttribute('aria-label'), el.getAttribute('autocomplete'), labelText(el),
    ].map((x) => (x || '').toLowerCase()).join(' ');
    if (type === 'email' || /e-?mail|بريد|ايميل|إيميل/.test(hay)) return 'email';
    if (type === 'tel' || /phone|mobile|\btel\b|whatsapp|هاتف|جوال|موبايل|رقم الهاتف/.test(hay)) return 'phone';
    if (/subject|الموضوع/.test(hay)) return 'subject';
    if (/message|enquir|inquir|comment|detail|query|feedback|رسالة|استفسار|تفاصيل|ملاحظات|طلب/.test(hay)) return 'message';
    if (/name|full.?name|الاسم|اسم/.test(hay)) return 'name';
    return 'other';
  };

  const fields: FieldDesc[] = [];
  let idx = 0;
  for (const el of Array.from(target.querySelectorAll(FILLABLE))) {
    const style = getComputedStyle(el as HTMLElement);
    const r = (el as HTMLElement).getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
    const tag = 'f' + idx++;
    el.setAttribute('data-sc-field', tag);
    fields.push({
      tag, kind: kindOf(el), tagName: el.tagName.toLowerCase(),
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    });
  }
  const submit = target.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  if (submit) submit.setAttribute('data-sc-submit', '1');
  const hasCaptcha = !!document.querySelector(
    '[class*="captcha"], [class*="recaptcha"], [data-sitekey], iframe[src*="captcha"], iframe[src*="recaptcha"], .g-recaptcha, .h-captcha',
  );
  return { found: true, fields, hasSubmit: !!submit, hasCaptcha, formAction: (target as HTMLFormElement).action || '' };
}

async function fillTaggedField(page: Page, tag: string, value: string): Promise<void> {
  const loc = page.locator(`[data-sc-field="${tag}"]`).first();
  try {
    const tagName = await loc.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === 'select') {
      const optVal = await loc.evaluate((el) => {
        const sel = el as HTMLSelectElement;
        const o = Array.from(sel.options).find((o) => o.value && !o.disabled && o.value !== '0');
        return o ? o.value : '';
      });
      if (optVal) await loc.selectOption(optVal).catch(() => {});
    } else {
      await loc.fill(value, { timeout: 4000 }).catch(async () => {
        await loc.type(value, { delay: 10, timeout: 6000 }).catch(() => {});
      });
    }
  } catch { /* field vanished */ }
}

// Detect whether a submit landed on a success/confirmation state.
async function detectSubmitOutcome(page: Page, beforeUrl: string): Promise<{ success: boolean; signal: string; error: string }> {
  await page.waitForTimeout(4000);
  return page.evaluate((beforeUrl) => {
    const urlChanged = location.href !== beforeUrl && /thank|success|confirm|submitted|شكر|تم/i.test(location.href);
    const bodyText = document.body.innerText;
    const thankText = /thank you|thanks|successfully|submission received|we have received|received your (message|enquiry|request)|شكرا|شكراً|تم الإرسال|تم استلام|تم بنجاح/i.test(bodyText);
    const successEl = !!document.querySelector('[class*="thank"], [class*="success"], [class*="confirmation"], [role="status"], .alert-success, .form-success');
    const formGone = document.querySelectorAll('form textarea').length === 0;
    const errEls = Array.from(document.querySelectorAll('[class*="error"]:not([class*="hidden"]), [role="alert"], .invalid-feedback, [aria-invalid="true"]'));
    const error = errEls.map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).join(' | ').slice(0, 300);
    const success = urlChanged || thankText || successEl || (formGone && !error);
    const signal = urlChanged ? 'url-change' : thankText ? 'thank-you-text' : successEl ? 'success-element' : formGone ? 'form-removed' : 'none';
    return { success, signal, error };
  }, beforeUrl);
}

// Thank-you detection for Q55 on the current (post-submit) page.
async function detectThankYou(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const el = document.querySelectorAll('[class*="thank"], [class*="success"], [class*="confirmation"], [role="status"], .alert-success');
    return el.length > 0 ||
      /thank you|thanks|successfully|submission received|we have received|received your|شكرا|شكراً|تم الإرسال|تم استلام/i.test(text);
  }).catch(() => false);
}

// ────────────────────────────────────────────────────────────
//  Q54 (+ Q55 + reply tail) — fill, gated submit, confirmation
// ────────────────────────────────────────────────────────────
async function runSubmitFlow(
  page: Page, url: string, auditJobId: string, language: string,
): Promise<CriterionResult[]> {
  const out: CriterionResult[] = [];
  const q54ss = ssPath(auditJobId, '54');

  const info = await page.evaluate(detectAndTagFields);
  if (!info.found) {
    out.push(makeResult('Q54', { status: 'fail', notes: 'A form was detected for Q53 but no fillable enquiry form could be resolved for submission.' }));
    out.push(makeResult('Q55', { status: 'fail', notes: 'No submittable form.' }));
    out.push(...replyTail('zero', 'No submittable enquiry form.'));
    return out;
  }

  // Fill the classified fields (phone intentionally left empty).
  const kinds = new Set(info.fields.map((f) => f.kind));
  for (const f of info.fields) {
    if (f.kind === 'phone') continue;
    if (f.kind === 'email') await fillTaggedField(page, f.tag, TEST_EMAIL || 'reviewer@example.com');
    else if (f.kind === 'name') await fillTaggedField(page, f.tag, TEST_NAME);
    else if (f.kind === 'message') await fillTaggedField(page, f.tag, ENQUIRY_MESSAGE);
    else if (f.kind === 'subject') await fillTaggedField(page, f.tag, TEST_SUBJECT);
    else if (f.tagName === 'select') await fillTaggedField(page, f.tag, '');
    else if (f.required) await fillTaggedField(page, f.tag, TEST_NAME); // required 'other' text
  }

  await takeElementScreenshot(page, q54ss.abs, ['form', 'textarea', '[data-sc-submit]', 'button[type="submit"]']);
  const fieldSummary = `Detected fields: ${info.fields.map((f) => f.kind).join(', ') || 'none'}.`;

  // CAPTCHA → cannot submit automatically (never solve CAPTCHAs).
  if (info.hasCaptcha) {
    out.push(makeResult('Q54', {
      status: 'na',
      screenshotPath: q54ss.rel,
      notes: `Form is protected by a CAPTCHA — automated submission is not attempted. ${fieldSummary} Submit manually to evaluate.`,
    }));
    out.push(makeResult('Q55', { status: 'na', notes: 'Deferred — CAPTCHA-protected form was not submitted.' }));
    out.push(...replyTail('na', 'Deferred — CAPTCHA-protected form was not submitted automatically.'));
    return out;
  }

  // Gated OFF → fill only.
  if (!SUBMIT_ENQUIRY) {
    const composable = kinds.has('email') && (kinds.has('message') || kinds.has('name'));
    out.push(makeResult('Q54', {
      status: 'na',
      screenshotPath: q54ss.rel,
      notes: `Form filled and ${composable ? 'submittable' : 'reachable'}; actual submission is gated (set SITECHECK_ENQUIRY_SUBMIT=1 for an attended run). ${fieldSummary}`,
    }));
    out.push(makeResult('Q55', { status: 'na', notes: 'Deferred — enquiry was not submitted (submission gated).' }));
    out.push(...replyTail('na', 'Deferred — enquiry was not submitted (submission gated).'));
    return out;
  }

  // Gated ON but no inbox configured.
  if (!TEST_EMAIL) {
    out.push(makeResult('Q54', {
      status: 'na',
      screenshotPath: q54ss.rel,
      notes: `Cannot submit: ENQUIRY_TEST_EMAIL is not set, so replies could not be received/graded. ${fieldSummary}`,
    }));
    out.push(makeResult('Q55', { status: 'na', notes: 'Deferred — no test inbox configured.' }));
    out.push(...replyTail('na', 'Deferred — no test inbox configured (ENQUIRY_TEST_EMAIL).'));
    return out;
  }

  // Submit for real.
  const beforeUrl = page.url();
  await page.locator('[data-sc-submit="1"]').first().click({ timeout: 5000 })
    .catch(async () => { await page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 5000 }).catch(() => {}); });

  const outcome = await detectSubmitOutcome(page, beforeUrl);
  const postSs = ssPath(auditJobId, '54');
  await viewportShot(page, postSs.abs);

  if (!outcome.success) {
    out.push(makeResult('Q54', {
      scoreEarned: 0,
      status: 'fail',
      screenshotPath: postSs.rel,
      notes: `Submission could not be confirmed.${outcome.error ? ` Error(s): ${outcome.error}` : ' No success confirmation appeared.'} ${fieldSummary}`,
      recommendation: getRecommendation('Q54'),
    }));
    out.push(makeResult('Q55', { status: 'fail', scoreEarned: 0, notes: 'No thank-you confirmation (submission not confirmed).', recommendation: getRecommendation('Q55') }));
    out.push(...replyTail('na', 'Not evaluated — the enquiry submission could not be confirmed.'));
    return out;
  }

  // Confirmed submit → Q54 pass, record the pending enquiry, emit the tail as pending.
  out.push(makeResult('Q54', {
    scoreEarned: 2,
    status: 'pass',
    screenshotPath: postSs.rel,
    notes: `Enquiry submitted successfully (confirmed via ${outcome.signal}). ${fieldSummary}`,
  }));

  const q55ss = ssPath(auditJobId, '55');
  await viewportShot(page, q55ss.abs);
  const hasThanks = await detectThankYou(page);
  out.push(makeResult('Q55', {
    scoreEarned: hasThanks ? 1 : 0,
    status: hasThanks ? 'pass' : 'fail',
    screenshotPath: q55ss.rel,
    notes: hasThanks ? 'A thank-you / confirmation message was shown after submission.' : 'No thank-you message detected after submission.',
    recommendation: hasThanks ? '' : getRecommendation('Q55'),
  }));

  const submittedAt = new Date();
  const deadlineAt = addBusinessDays(submittedAt, 2);
  try {
    await prisma.pendingEnquiry.create({
      data: {
        auditJobId,
        inbox: TEST_EMAIL,
        entityDomain: hostOf(url),
        language,
        sentSubject: TEST_SUBJECT,
        submittedAt,
        deadlineAt,
        resolved: false,
      },
    });
  } catch (e) {
    console.error('[SiteCheck] Failed to record PendingEnquiry:', e);
  }

  out.push(...replyTail('pending',
    `Awaiting email reply to ${TEST_EMAIL}. Auto-reply and personalized reply will be graded by the background poller (deadline ${deadlineAt.toISOString().slice(0, 10)}; scores 0 if no reply by then).`));
  return out;
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar10Enquiry(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId } = params;
  const results: CriterionResult[] = [];

  await dismissCookieBanner(page);
  const { result: q53, formInfo } = await checkQ53(page, auditJobId);
  results.push(q53);

  if (!formInfo.found) {
    // No enquiry channel → the whole pillar is 0; do not evaluate the rest.
    results.push(makeResult('Q54', { status: 'fail', scoreEarned: 0, notes: 'No enquiry form to submit — the entity offers no enquiry channel.', recommendation: getRecommendation('Q54') }));
    results.push(makeResult('Q55', { status: 'fail', scoreEarned: 0, notes: 'No enquiry form.', recommendation: getRecommendation('Q55') }));
    results.push(...replyTail('zero', 'No enquiry form — no submission or reply possible.'));
    try { await navigateAndWait(page, url); } catch { /* */ }
    return results;
  }

  const language = await page.evaluate(() => (document.documentElement.lang || '').toLowerCase().startsWith('ar') ? 'ar' : 'en').catch(() => 'en');
  results.push(...await runSubmitFlow(page, url, auditJobId, language));

  try { await navigateAndWait(page, url); } catch { /* */ }
  return results;
}
