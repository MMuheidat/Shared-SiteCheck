// lib/engine/enquiry-grade.ts — grade the enquiry email reply(s) (Pillar 10 tail)
//
// Given a pending enquiry and the emails fetched from the test inbox, this
// classifies the auto-reply vs the personalized reply, scores the timing
// questions from timestamps, classifies the sender, and judges the soft-skill
// questions with the SAME pluggable LLM judge used for live chat (free Ollama by
// default). Pure/deterministic except the LLM call; no DB access here — the
// caller (scripts/poll-enquiries.ts) persists the returned results.

import { judgeTranscript, type JudgeQuestion, type JudgeVerdict } from '@/lib/engine/livechat-judge';
import { businessDaysBetween } from '@/lib/engine/enquiry-shared';
import type { EmailMsg } from '@/lib/engine/enquiry-inbox';

export interface PendingLike {
  inbox: string;
  submittedAt: Date;
  deadlineAt: Date;
  entityDomain: string;
  language: string; // 'ar' | 'en'
}

export interface GradedResult {
  qid: string;
  status: 'pass' | 'fail' | 'partial' | 'na' | 'pending';
  scoreEarned: number;
  notes: string;
}

interface EmailSpec extends JudgeQuestion { maxScore: number }

// Auto-reply soft-skill questions (graded on the automated acknowledgement).
const AUTO_SPECS: EmailSpec[] = [
  { id: 'Q58', scale: 'binary', maxScore: 1, criterion: 'The automated reply is free of spelling and grammatical mistakes.' },
  { id: 'Q58b', scale: 'binary', maxScore: 1, criterion: 'The automated reply specifies the expected time for the entity to respond AND/OR the next steps.' },
];

// Personalized-reply questions (graded on the human staff reply).
const PERSONAL_SPECS: EmailSpec[] = [
  { id: 'Q61', scale: 'binary', maxScore: 1, criterion: 'The reply opens with a proper salutation (e.g. "Good morning", "Dear ...", "Good afternoon").' },
  { id: 'Q62', scale: 'binary', maxScore: 1, criterion: 'The reply is free of spelling and grammatical errors.' },
  { id: 'Q63', scale: 'binary', maxScore: 1, criterion: 'The reply is written in the customer\'s preferred language (LANG_PLACEHOLDER).' },
  { id: 'Q63b', scale: 'binary', maxScore: 1, criterion: 'The reply uses a professional and respectful tone.' },
  { id: 'Q63c', scale: 'binary', maxScore: 1, criterion: 'The reply uses simple, clear and concise language for easy understanding.' },
  { id: 'Q63d', scale: 'binary', maxScore: 1, criterion: 'The reply is formal and free from contractions (e.g. "don\'t"), technical jargon, abbreviations, acronyms, or sensitive information.' },
  { id: 'Q63e', scale: 'binary', maxScore: 1, criterion: 'Dates and numbers are written correctly (e.g. "15 April 2025"; "10:30AM"; "AED 35,000"; "+971 50 123 4567"). If none appear, rate "na".' },
  { id: 'Q63f', scale: 'binary', maxScore: 1, criterion: 'The reply thanks the customer for reaching out / for their enquiry, anywhere in the message.' },
  { id: 'Q64', scale: 'binary', maxScore: 2, criterion: 'The reply provides the requested details about the query (e.g. process, fees, timeline, required documents).' },
  { id: 'Q65', scale: 'binary', maxScore: 1, criterion: 'The reply follows a proper email closing (e.g. "Best regards", the agent\'s name, or a positive closing statement).' },
  { id: 'Q66', scale: 'binary', maxScore: 1, criterion: 'The information provided is plausible and internally consistent with a typical entity service catalogue (no contradictory or clearly false claims).' },
];

function scoreOf(spec: EmailSpec, rating: JudgeVerdict['rating']): number | null {
  if (rating === 'na') return null;
  if (spec.scale === 'tiered') return rating === 'yes' ? spec.maxScore : rating === 'partial' ? spec.maxScore * 0.5 : 0;
  return rating === 'no' ? 0 : rating === 'partial' ? spec.maxScore * 0.5 : spec.maxScore;
}

function statusOf(spec: EmailSpec, score: number | null): GradedResult['status'] {
  if (score === null) return 'na';
  if (score >= spec.maxScore && spec.maxScore > 0) return 'pass';
  return score > 0 ? 'partial' : 'fail';
}

const isTammDomain = (d: string) => /tamm\.abudhabi|tamm\.ae/.test(d);
const isNoReply = (from: string) => /no[-_.]?reply|donotreply|do-not-reply|automated|auto-?reply|mailer-daemon|postmaster|notification/i.test(from);

// Classify which fetched email is the auto-reply and which is the personalized reply.
export function classifyReplies(pending: PendingLike, emails: EmailMsg[]): { auto: EmailMsg | null; personal: EmailMsg | null } {
  const submitMs = pending.submittedAt.getTime();
  let auto: EmailMsg | null = null;
  let personal: EmailMsg | null = null;
  for (const e of emails) {
    const mins = (e.date.getTime() - submitMs) / 60000;
    if (!auto && (mins <= 5 || isNoReply(e.from))) { auto = e; continue; }
    if (!personal && e !== auto) { personal = e; }
  }
  return { auto, personal };
}

async function judgeEmail(specs: EmailSpec[], email: EmailMsg, pending: PendingLike): Promise<Map<string, JudgeVerdict>> {
  const langName = pending.language === 'ar' ? 'Arabic' : 'English';
  const questions = specs.map((s) => ({
    id: s.id,
    scale: s.scale,
    criterion: s.criterion.replace('LANG_PLACEHOLDER', langName),
  }));
  const judge = await judgeTranscript({
    entityName: pending.entityDomain || 'the entity',
    language: langName,
    transcript: [{ role: 'agent', text: email.text.slice(0, 8000) }],
    questions,
  });
  const map = new Map<string, JudgeVerdict>();
  if (judge.available) for (const v of judge.verdicts) map.set(v.id, v);
  return map;
}

// Grade the enquiry tail. `done` is true when the personalized reply arrived or
// the deadline has passed (nothing more to wait for).
export async function gradeEnquiry(
  pending: PendingLike, emails: EmailMsg[], now: Date,
): Promise<{ done: boolean; results: GradedResult[] }> {
  const { auto, personal } = classifyReplies(pending, emails);
  const pastDeadline = now >= pending.deadlineAt;
  const done = !!personal || pastDeadline;
  const results: GradedResult[] = [];

  // ── Auto-reply block: Q56 timing, Q57 from, Q58 grammar, Q58b timeframe ──
  if (auto) {
    const mins = (auto.date.getTime() - pending.submittedAt.getTime()) / 60000;
    let q56 = 0, q56tier = '';
    if (mins <= 1) { q56 = 1; q56tier = 'immediately / within 1 min'; }
    else if (mins <= 5) { q56 = 0.5; q56tier = '1–5 min'; }
    else { q56 = 0; q56tier = 'more than 5 min'; }
    results.push({ qid: 'Q56', status: q56 >= 1 ? 'pass' : q56 > 0 ? 'partial' : 'fail', scoreEarned: q56, notes: `Auto-reply received ${q56tier} after submission (${Math.round(mins)} min).` });

    const fromTamm = isTammDomain(auto.fromDomain);
    results.push({ qid: 'Q57', status: 'na', scoreEarned: 0, notes: `Auto-reply from: ${fromTamm ? 'Tamm' : 'Entity'} (${auto.fromDomain || auto.from}).` });

    const verdicts = await judgeEmail(AUTO_SPECS, auto, pending);
    for (const spec of AUTO_SPECS) {
      const v = verdicts.get(spec.id);
      if (!v) { results.push({ qid: spec.id, status: 'na', scoreEarned: 0, notes: 'LLM judgment unavailable for the auto-reply — assess manually.' }); continue; }
      const s = scoreOf(spec, v.rating);
      results.push({ qid: spec.id, status: statusOf(spec, s), scoreEarned: s ?? 0, notes: `LLM verdict: ${v.rating.toUpperCase()}. ${v.justification}` });
    }
  } else if (done) {
    results.push({ qid: 'Q56', status: 'fail', scoreEarned: 0, notes: 'No automatic reply was received after submission.' });
    results.push({ qid: 'Q57', status: 'na', scoreEarned: 0, notes: 'No auto-reply received.' });
    results.push({ qid: 'Q58', status: 'na', scoreEarned: 0, notes: 'No auto-reply received.' });
    results.push({ qid: 'Q58b', status: 'na', scoreEarned: 0, notes: 'No auto-reply received.' });
  } else {
    for (const qid of ['Q56', 'Q57', 'Q58', 'Q58b']) results.push({ qid, status: 'pending', scoreEarned: 0, notes: 'Awaiting reply.' });
  }

  // ── Personalized-reply block: Q59 timing, Q59b channel, Q60 from, Q61–Q66 ──
  if (personal) {
    const elapsed = businessDaysBetween(pending.submittedAt, personal.date);
    let q59 = 0, tier = '';
    if (elapsed <= 1) { q59 = 2; tier = 'within 1 business day'; }
    else if (elapsed <= 2) { q59 = 1; tier = '1–2 business days'; }
    else { q59 = 0; tier = 'more than 2 business days'; }
    results.push({ qid: 'Q59', status: q59 >= 2 ? 'pass' : q59 > 0 ? 'partial' : 'fail', scoreEarned: q59, notes: `Personalized reply received ${tier} (${elapsed} business day(s)) after submission.` });
    results.push({ qid: 'Q59b', status: 'na', scoreEarned: 0, notes: 'Reply received through: Email.' });
    const fromTamm = isTammDomain(personal.fromDomain);
    results.push({ qid: 'Q60', status: 'na', scoreEarned: 0, notes: `Reply from: ${fromTamm ? 'Tamm' : 'Entity'} (${personal.fromDomain || personal.from}).` });

    const verdicts = await judgeEmail(PERSONAL_SPECS, personal, pending);
    for (const spec of PERSONAL_SPECS) {
      const v = verdicts.get(spec.id);
      if (!v) { results.push({ qid: spec.id, status: 'na', scoreEarned: 0, notes: 'LLM judgment unavailable for the reply — assess manually.' }); continue; }
      const s = scoreOf(spec, v.rating);
      results.push({ qid: spec.id, status: statusOf(spec, s), scoreEarned: s ?? 0, notes: `LLM verdict: ${v.rating.toUpperCase()}. ${v.justification}` });
    }
  } else if (done) {
    // Deadline passed with no personalized reply → scored questions score 0.
    results.push({ qid: 'Q59', status: 'fail', scoreEarned: 0, notes: 'No personalized reply received within 2 business days.' });
    results.push({ qid: 'Q59b', status: 'na', scoreEarned: 0, notes: 'No personalized reply received.' });
    results.push({ qid: 'Q60', status: 'na', scoreEarned: 0, notes: 'No personalized reply received.' });
    for (const spec of PERSONAL_SPECS) results.push({ qid: spec.id, status: 'fail', scoreEarned: 0, notes: 'No personalized reply received within the deadline.' });
  } else {
    for (const qid of ['Q59', 'Q59b', 'Q60', ...PERSONAL_SPECS.map((s) => s.id)]) {
      results.push({ qid, status: 'pending', scoreEarned: 0, notes: 'Awaiting personalized reply.' });
    }
  }

  return { done, results };
}
