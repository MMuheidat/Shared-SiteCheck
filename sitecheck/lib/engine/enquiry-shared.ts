// lib/engine/enquiry-shared.ts — shared config + helpers for the Enquiry Form
// journey (Pillar 10), used by both the browser phase (pillar10-enquiry.ts) and
// the async email-grading phase (enquiry-grade.ts / scripts/poll-enquiries.ts).

// Submitting a real enquiry messages the entity's inbox, so the actual submit
// click is gated (mirrors pillar9's SITECHECK_LIVECHAT_SUBMIT). Off by default.
export const SUBMIT_ENQUIRY = process.env.SITECHECK_ENQUIRY_SUBMIT === '1';

// The test identity used to fill the form. The email is the inbox the poller
// watches for replies — the user provides it in .env.
export const TEST_NAME = process.env.ENQUIRY_TEST_NAME || 'Site Check Reviewer';
export const TEST_EMAIL = process.env.ENQUIRY_TEST_EMAIL || '';
export const TEST_SUBJECT = 'Enquiry about your services';
export const ENQUIRY_MESSAGE =
  'Hello, I would like to know more about the services you provide — the steps to apply, ' +
  'the required documents, the fees, and the expected timeline. Could you please share these ' +
  'details? Thank you.';

// The reply-dependent questions (auto-reply + personalized reply), in sheet order.
// Q57, Q59b, Q60 are non-scored classifications; the rest are scored.
export const REPLY_QIDS = [
  'Q56', 'Q57', 'Q58', 'Q58b', 'Q59', 'Q59b', 'Q60',
  'Q61', 'Q62', 'Q63', 'Q63b', 'Q63c', 'Q63d', 'Q63e', 'Q63f', 'Q64', 'Q65', 'Q66',
] as const;

// UAE work week is Mon–Fri; weekend is Sat & Sun.
export function isWeekend(d: Date): boolean {
  const g = d.getDay(); // 0 Sun … 6 Sat
  return g === 0 || g === 6;
}

// The date `n` business days after `from`.
export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) added++;
  }
  return d;
}

// Whole business days elapsed between two instants (weekends excluded).
export function businessDaysBetween(start: Date, end: Date): number {
  if (end <= start) return 0;
  let count = 0;
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);
  while (cur < endDay) {
    cur.setDate(cur.getDate() + 1);
    if (!isWeekend(cur)) count++;
  }
  return count;
}

export function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}
