// lib/engine/pillar9-livechat.ts — Live Chat Journey
//
// Automates the live-chat "mystery shopper" journey end-to-end:
//   Q37  — live chat available (detect widget)                      [non-scored]
//   Q38  — own chat / powered-by-Tamm / Tamm website                [non-scored]
//   Q39  — chat load time (≤2s=1 / 3-5s=0.5 / >5s|none=0)           [scored, own chat]
//   Q40  — working hours listed                                     [scored, own chat]
//   Q41  — support available during stated hours                    [manual/live]
//   Q42  — query submitted successfully                             [scored, own chat]
//   Q43  — support type (virtual / human)                           [scored, own chat]
//   Q44b — human-agent response time                                [human only]
//   Q45–Q52c — conversation quality (greeting, tone, language,      [scored, LLM-judged]
//              grammar, further-assistance, thanks, helpfulness…)
//
// Q38 classification (the key branch):
//   • OWN CHAT ("not_tamm", SCORED) — the chat is hosted by the audited site
//     itself. THIS INCLUDES when the audited entity IS TAMM: TAMM's AI assistant
//     is TAMM's own chat and is fully scored. Runs Q39/Q40/Q42 + conversation.
//   • POWERED BY TAMM — audited site is *not* Tamm but its widget loads from a
//     Tamm domain → NA for the entity.
//   • TAMM WEBSITE — audited (non-Tamm) site sends the user off to the Tamm site
//     for chat → NA for the entity.
//   Only the OWN-CHAT branch is scored (see [[engine-must-generalize]] — do not
//   overfit: TAMM-as-audited-target is a normal entity, not a special NA case).
//
// The soft-skill questions (Q45–Q52c) are judged by an LLM over the captured
// transcript — see lib/engine/livechat-judge.ts, which defaults to a FREE local
// Ollama model (no API credits) and can be flipped to Claude via env.
//
// Side effects & gating: submitting a real query messages a live support desk,
// so the whole conversation (submit + follow-ups + video recording) is gated
// behind SITECHECK_LIVECHAT_SUBMIT=1 (off by default). When off, the widget is
// opened and the compose box confirmed reachable, but nothing is sent and the
// conversation questions are emitted as NA for the interactive phase.

import type { Page, Frame, Browser } from 'playwright';
import type { CriterionResult } from '@/lib/types';
import { getCriterion, getRecommendation } from '@/lib/scoring';
import path from 'path';
import { navigateAndWait, takeHighlightedScreenshot, dismissCookieBanner } from '@/lib/engine/helpers';
import {
  detectPlatform, findLauncher, findCompose, extractTranscript,
  type PlatformAdapter, type TranscriptMessage,
} from '@/lib/engine/livechat-platforms';
import { judgeTranscript, type JudgeQuestion, type JudgeVerdict } from '@/lib/engine/livechat-judge';

const PILLAR = 'Live Chat';
const SUBMIT_TEST_QUERY = process.env.SITECHECK_LIVECHAT_SUBMIT === '1';
const TEST_QUERY = 'Hello, I would like some information about your services please.';
const FOLLOWUP_QUERY = 'Thank you. Is there anything else you can help me with?';

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
  const fileName = `q${qid}.png`;
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

const INTERACTIVE_NA =
  'Conversation not held on this run (query submission is gated by SITECHECK_LIVECHAT_SUBMIT) — deferred to the interactive/screen-record phase.';

const CHAT_WIDGET_SELECTORS = [
  '[class*="chat-widget"]', '[class*="chatwidget"]', '[class*="chat-bot"]', '[class*="chatbot"]',
  '[id*="chat-widget"]', '[id*="chatwidget"]', '[class*="live-chat"]', '[class*="livechat"]',
  '[id*="live-chat"]', '[id*="livechat"]',
  '#hubspot-messages-iframe-container', '#intercom-container', '[class*="intercom"]',
  '#drift-widget', '[class*="drift"]', '#tidio-chat', '[class*="tidio"]',
  '#crisp-chatbox', '[class*="crisp"]', '#tawk-bubble-container', '[class*="tawk"]',
  '#zsiq_float', '[class*="zsiq"]', '#fc_frame', '[class*="freshchat"]',
  '[class*="floating-chat"]', '[class*="chat-bubble"]', '[class*="chat-icon"]',
  '[class*="chat-button"]', '[class*="support-chat"]',
  'iframe[src*="chat" i]', 'iframe[title*="chat" i]',
];

interface ChatDetection {
  found: boolean;
  elementFound: boolean;
  scriptCount: number;
  hasText: boolean;
  tammLinked: boolean;
}

async function detectChat(page: Page): Promise<ChatDetection> {
  await page.waitForTimeout(3000);
  return page.evaluate((widgetSelectors: string[]) => {
    let elementFound = false;
    for (const sel of widgetSelectors) {
      try { if (document.querySelector(sel)) { elementFound = true; break; } } catch { /* */ }
    }
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    const chatScripts = scripts.filter(s => {
      const src = (s.getAttribute('src') || '').toLowerCase();
      return /chat|intercom|drift|tawk|crisp|tidio|freshchat|zendesk|livechat|liveperson|genesys/.test(src);
    });
    const html = document.body.innerHTML.toLowerCase();
    const hasText =
      html.includes('live chat') || html.includes('الدردشة المباشرة') ||
      html.includes('chat with us') || html.includes('تحدث معنا') || html.includes('دردشة');

    // Is any chat resource loaded from a TAMM domain?
    const iframes = Array.from(document.querySelectorAll('iframe[src]')).map(f => (f as HTMLIFrameElement).src.toLowerCase());
    const scriptSrcs = scripts.map(s => (s.getAttribute('src') || '').toLowerCase());
    const chatLinks = Array.from(document.querySelectorAll('a[href]')).map(a => (a as HTMLAnchorElement).href.toLowerCase());
    const tammLinked = [...iframes, ...scriptSrcs].some(u => /tamm\.abudhabi|tamm\.ae/.test(u)) ||
      chatLinks.some(u => /tamm\.abudhabi|tamm\.ae/.test(u) && /chat/.test(u));

    return {
      found: elementFound || chatScripts.length > 0 || hasText,
      elementFound,
      scriptCount: chatScripts.length,
      hasText,
      tammLinked,
    };
  }, CHAT_WIDGET_SELECTORS);
}

// Measure time until a chat widget becomes visible after a fresh load.
async function measureChatLoad(page: Page, url: string): Promise<number | null> {
  const start = Date.now();
  await navigateAndWait(page, url, { waitAfter: 0 });
  for (let i = 0; i < 24; i++) { // up to ~12s
    const visible = await page.evaluate((sels: string[]) => {
      for (const sel of sels) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const s = getComputedStyle(el as HTMLElement);
            const r = (el as HTMLElement).getBoundingClientRect();
            if (s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0) return true;
          }
        } catch { /* */ }
      }
      return false;
    }, CHAT_WIDGET_SELECTORS);
    if (visible) return (Date.now() - start) / 1000;
    await page.waitForTimeout(500);
  }
  return null; // never appeared
}

// ────────────────────────────────────────────────────────────
//  Conversation session (recorded) — used only when SUBMIT is enabled
// ────────────────────────────────────────────────────────────

interface ChatSession {
  opened: boolean;
  submitted: boolean;
  agentType: 'virtual' | 'human' | 'unknown';
  firstReplyMs: number | null;
  transcript: TranscriptMessage[];
  videoRel: string | null;
  platformId: string | null;
  error?: string;
}

// Send a message into the compose box (frame-aware), trying fill then type,
// then Enter, then a nearby send button.
async function sendMessage(
  ctx: Page | Frame,
  locator: import('playwright').Locator,
  text: string,
): Promise<void> {
  await locator.click({ timeout: 3000 }).catch(() => {});
  const filled = await locator.fill(text, { timeout: 3000 }).then(() => true).catch(() => false);
  if (!filled) {
    await locator.type(text, { delay: 15, timeout: 6000 }).catch(() => {});
  }
  await locator.press('Enter').catch(() => {});
  // Some widgets need an explicit send button rather than Enter.
  const sendBtn = ctx.locator(
    'button[aria-label*="send" i], button[title*="send" i], button[class*="send" i], [class*="send-button"]',
  ).first();
  if (await sendBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await sendBtn.click({ timeout: 1500 }).catch(() => {});
  }
}

// Poll the transcript until a new agent/unknown message arrives (or timeout).
async function waitForReply(
  page: Page, adapter: PlatformAdapter, priorCount: number, timeoutMs: number,
): Promise<{ replied: boolean; ms: number; transcript: TranscriptMessage[] }> {
  const start = Date.now();
  let transcript: TranscriptMessage[] = [];
  while (Date.now() - start < timeoutMs) {
    transcript = await extractTranscript(page, adapter);
    // A reply is any non-user message beyond what we had before sending.
    const agentMsgs = transcript.filter(m => m.role !== 'user');
    if (transcript.length > priorCount && agentMsgs.length > 0) {
      return { replied: true, ms: Date.now() - start, transcript };
    }
    await page.waitForTimeout(500);
  }
  return { replied: false, ms: Date.now() - start, transcript };
}

async function conductChatSession(
  browser: Browser, url: string, auditJobId: string,
): Promise<ChatSession> {
  const out: ChatSession = {
    opened: false, submitted: false, agentType: 'unknown',
    firstReplyMs: null, transcript: [], videoRel: null, platformId: null,
  };
  const videoDir = path.join(process.cwd(), 'public', 'screenshots', auditJobId, 'video-tmp');
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const video = page.video();

  try {
    await navigateAndWait(page, url, { waitAfter: 2000 });
    await dismissCookieBanner(page);

    const adapter = await detectPlatform(page);
    if (!adapter) { out.error = 'no chat platform detected in recorded session'; return out; }
    out.platformId = adapter.id;

    // Open the widget.
    const launcher = await findLauncher(page, adapter);
    if (launcher) {
      await launcher.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(3500);
    }
    const compose = await findCompose(page, adapter);
    if (!compose) { out.error = 'compose box not reachable in recorded session'; out.opened = !!launcher; return out; }
    out.opened = true;

    const ctx: Page | Frame = compose.frame ?? page;

    // Capture whatever greeting the bot shows on open.
    const beforeSend = await extractTranscript(page, adapter);

    // Send the first query and time the reply.
    await sendMessage(ctx, compose.locator, TEST_QUERY);
    out.submitted = true;
    const first = await waitForReply(page, adapter, beforeSend.length + 1, 20000);
    out.firstReplyMs = first.replied ? first.ms : null;

    // Classify bot vs human: bots reply near-instantly and/or self-identify.
    const labelText = (await page.evaluate(() =>
      document.body.innerText.toLowerCase()).catch(() => '')) || '';
    const virtualLabel = /virtual assistant|ai assistant|chatbot|bot\b|مساعد افتراضي|مساعد ذكي|automated/.test(labelText);
    if (first.replied && (first.ms < 8000 || virtualLabel)) {
      out.agentType = 'virtual';
    } else if (first.replied) {
      out.agentType = 'human';
    } else {
      out.agentType = 'unknown';
    }

    // Only converse further with a bot (never spam a human agent).
    if (out.agentType === 'virtual') {
      const afterFirst = first.transcript.length || beforeSend.length + 2;
      await sendMessage(ctx, compose.locator, FOLLOWUP_QUERY);
      await waitForReply(page, adapter, afterFirst + 1, 15000);
    }

    out.transcript = await extractTranscript(page, adapter);
    return out;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  } finally {
    await context.close().catch(() => {});
    // Flush the recording into the audit's screenshot folder.
    if (video) {
      const target = path.join(process.cwd(), 'public', 'screenshots', auditJobId, 'livechat.webm');
      await video.saveAs(target).then(() => {
        out.videoRel = `/screenshots/${auditJobId}/livechat.webm`;
      }).catch(() => { /* recording unavailable */ });
    }
  }
}

// ────────────────────────────────────────────────────────────
//  LLM-judged conversation questions
// ────────────────────────────────────────────────────────────

interface JudgeSpec extends JudgeQuestion { maxScore: number; scored: boolean }

function conversationSpecs(language: string): JudgeSpec[] {
  return [
    { id: 'Q45', scale: 'tiered', maxScore: 3, scored: true,
      criterion: 'The agent opened with a standard greeting (e.g., "Hello", "Salam Alaikom", "Welcome to <entity>").' },
    { id: 'Q46', scale: 'tiered', maxScore: 3, scored: true,
      criterion: 'The agent used a professional and respectful tone throughout the conversation.' },
    { id: 'Q46b', scale: 'binary', maxScore: 1, scored: true,
      criterion: 'The agent addressed the customer EITHER by their name OR with any courteous expression such as "dear customer", "dear sir/madam", "valued customer" or similar. If any such courteous address appears anywhere, rate "yes".' },
    { id: 'Q47', scale: 'binary', maxScore: 1, scored: true,
      criterion: `The agent communicated in the customer's preferred language (${language}).` },
    { id: 'Q47b', scale: 'binary', maxScore: 1, scored: true,
      criterion: 'The agent used simple, clear and concise language to ensure the customer understood.' },
    { id: 'Q47c', scale: 'binary', maxScore: 1, scored: true,
      criterion: 'The agent\'s statements were formal and free from contractions (e.g., "don\'t"), technical jargon, abbreviations, acronyms, or sensitive information.' },
    { id: 'Q49b', scale: 'binary', maxScore: 1, scored: true,
      criterion: 'The agent wrote any dates and numbers correctly (e.g., "15 April 2025"; "10:30AM"; "AED 35,000"; "+971 50 123 4567"). If no dates/numbers appear, rate "na".' },
    { id: 'Q52b', scale: 'binary', maxScore: 1, scored: true,
      criterion: 'The agent\'s responses were free of spelling and grammatical mistakes.' },
    { id: 'Q50', scale: 'binary', maxScore: 2, scored: true,
      criterion: 'The agent asked whether the customer needs anything else, or offered further help — e.g. "Is there anything else I can help you with?" or "Let me know if you need more assistance." Any such question or offer counts as "yes".' },
    { id: 'Q51', scale: 'binary', maxScore: 2, scored: true,
      criterion: 'The agent thanked the customer for reaching out / for their contact at some point in the conversation.' },
    { id: 'Q49', scale: 'tiered', maxScore: 2, scored: true,
      criterion: 'The agent was helpful in answering the query (e.g., process, fees, timeline, requirements).' },
    { id: 'Q52', scale: 'binary', maxScore: 1, scored: true,
      criterion: 'The information the agent provided is plausible and internally consistent (no contradictory or clearly false claims about the entity\'s services).' },
    // Non-scored (max 0) — judged only for the notes/report.
    { id: 'Q51a', scale: 'binary', maxScore: 0, scored: false,
      criterion: 'The agent summarised the key points discussed and confirmed the customer\'s needs were fully addressed.' },
    { id: 'Q51b', scale: 'binary', maxScore: 0, scored: false,
      criterion: 'The agent provided clear instructions for follow-up actions and clarified next steps.' },
    { id: 'Q52c', scale: 'binary', maxScore: 0, scored: false,
      criterion: 'The agent offered a satisfaction survey at the end of the conversation.' },
  ];
}

// Map an LLM verdict to a CriterionResult score for a spec.
function verdictToResult(spec: JudgeSpec, verdict: JudgeVerdict | undefined): CriterionResult {
  if (!verdict || verdict.rating === 'na') {
    return makeResult(spec.id, {
      status: 'na',
      notes: verdict?.justification
        ? `Not judgeable from the transcript: ${verdict.justification}`
        : 'Not enough evidence in the transcript to judge this criterion.',
    });
  }
  let score: number;
  if (spec.scale === 'tiered') {
    score = verdict.rating === 'yes' ? spec.maxScore : verdict.rating === 'partial' ? spec.maxScore * 0.5 : 0;
  } else {
    score = verdict.rating === 'no' ? 0 : verdict.rating === 'partial' ? spec.maxScore * 0.5 : spec.maxScore;
  }
  const status: CriterionResult['status'] =
    score >= spec.maxScore && spec.maxScore > 0 ? 'pass' : score > 0 ? 'partial' : spec.scored ? 'fail' : 'pass';
  return makeResult(spec.id, {
    scoreEarned: spec.scored ? score : 0,
    status: spec.maxScore === 0 ? (verdict.rating === 'yes' ? 'pass' : 'fail') : status,
    notes: `LLM verdict: ${verdict.rating.toUpperCase()}. ${verdict.justification}`,
    recommendation: (spec.scored && score < spec.maxScore) ? getRecommendation(spec.id) : '',
  });
}

// ────────────────────────────────────────────────────────────
//  Export
// ────────────────────────────────────────────────────────────
export default async function pillar9LiveChat(params: {
  page: Page;
  url: string;
  auditJobId: string;
  entityName: string;
  previousResults: CriterionResult[];
}): Promise<CriterionResult[]> {
  const { page, url, auditJobId, entityName } = params;
  const results: CriterionResult[] = [];

  await dismissCookieBanner(page);
  const chat = await detectChat(page);

  // Preferred interaction language — our test messages are English, so the agent
  // should reply in English; this is what Q47 is judged against.
  const language = 'English';

  // Full conversation block, emitted in criteria-sheet order.
  const conversationOrder = [
    'Q43', 'Q44b', 'Q45', 'Q46', 'Q46b', 'Q47', 'Q47b', 'Q47c',
    'Q49b', 'Q52b', 'Q50', 'Q51', 'Q51a', 'Q51b', 'Q49', 'Q52', 'Q52c',
  ];

  // ── Q37 — Live chat available (non-scored) ──
  {
    const ss = ssPath(auditJobId, '37');
    await takeHighlightedScreenshot(page, ss.abs, CHAT_WIDGET_SELECTORS, {
      contextualZoom: true,
      label: 'Live Chat',
      maxHighlightBox: { width: 500, height: 400 },
    });
    results.push(makeResult('Q37', {
      status: chat.found ? 'pass' : 'na',
      screenshotPath: ss.rel,
      notes: chat.found
        ? `Live chat detected. Widget element: ${chat.elementFound ? 'Yes' : 'No'}, chat scripts: ${chat.scriptCount}, chat text: ${chat.hasText ? 'Yes' : 'No'}.`
        : 'No live chat widget, chatbot, or chat script detected on the website.',
      recommendation: chat.found ? '' : getRecommendation('Q37'),
    }));
  }

  // No chat → everything downstream is not applicable
  if (!chat.found) {
    results.push(makeResult('Q38', { status: 'skipped', notes: 'Skipped — no live chat feature detected (Q37).' }));
    for (const qid of ['Q39', 'Q40', 'Q41', 'Q42', ...conversationOrder]) {
      results.push(makeResult(qid, { status: 'skipped', notes: 'Skipped — no live chat feature detected (Q37).' }));
    }
    return results;
  }

  // ── Q38 — own chat / powered-by-Tamm / Tamm website (non-scored) ──
  // The audited site's OWN chat is scored — including when the audited entity IS
  // TAMM (TAMM's assistant is TAMM's own chat). The Tamm-delegation branches only
  // apply to a *non-Tamm* entity whose chat is served by / redirects to Tamm.
  const auditedHost = hostOf(url);
  const auditedIsTamm = isTammHost(auditedHost);
  const provider: 'not_tamm' | 'powered_by_tamm' | 'tamm_website' =
    auditedIsTamm ? 'not_tamm' : chat.tammLinked ? 'powered_by_tamm' : 'not_tamm';
  const providerLabel = {
    not_tamm: auditedIsTamm
      ? "This is TAMM's own live chat (AI assistant) — the audited entity is TAMM, so its chat is evaluated as the entity's own."
      : "Live chat is the entity's own (not Tamm-powered).",
    powered_by_tamm: 'Live chat is powered by TAMM (chat resources load from a TAMM domain).',
    tamm_website: 'The entity directs users to the TAMM website for live chat.',
  }[provider];
  results.push(makeResult('Q38', { status: 'pass', notes: providerLabel, recommendation: '' }));

  // ── Powered-by-Tamm → the entity is not evaluated on the chat itself (NA) ──
  if (provider !== 'not_tamm') {
    const tammNa = 'Not applicable — the entity delegates live chat to TAMM; the chat experience is not scored against this entity (per the criteria).';
    results.push(makeResult('Q39', { status: 'na', notes: tammNa }));
    results.push(makeResult('Q40', { status: 'na', notes: tammNa }));
    results.push(makeResult('Q41', { status: 'skipped', notes: 'Skipped — depends on Q40 (working hours).' }));
    results.push(makeResult('Q42', { status: 'na', notes: tammNa }));
    for (const qid of conversationOrder) {
      results.push(makeResult(qid, { status: 'na', notes: tammNa }));
    }
    return results;
  }

  // ── Entity's own chat → automate Q39, Q40, Q42 ──

  // Q39 — load time tiers (≤2s = 1, 3-5s = 0.5, >5s or doesn't load = 0)
  {
    const loadSec = await measureChatLoad(page, url);
    const ss = ssPath(auditJobId, '39');
    await takeHighlightedScreenshot(page, ss.abs, CHAT_WIDGET_SELECTORS, {
      contextualZoom: true,
      label: 'Live Chat',
      maxHighlightBox: { width: 500, height: 400 },
    });
    let score = 0;
    let label: string;
    if (loadSec === null) { score = 0; label = "doesn't load within 12s"; }
    else if (loadSec <= 2) { score = 1; label = `${loadSec.toFixed(2)}s (≤ 2s)`; }
    else if (loadSec <= 5) { score = 0.5; label = `${loadSec.toFixed(2)}s (3–5s)`; }
    else { score = 0; label = `${loadSec.toFixed(2)}s (> 5s)`; }
    results.push(makeResult('Q39', {
      scoreEarned: score,
      status: score === 1 ? 'pass' : score > 0 ? 'partial' : 'fail',
      screenshotPath: ss.rel,
      notes: `Live chat widget load time: ${label}.`,
      recommendation: score === 1 ? '' : getRecommendation('Q39'),
    }));
  }

  // Q40 — working hours clearly listed
  {
    const hours = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasHours =
        text.includes('working hours') || text.includes('ساعات العمل') || text.includes('support hours') ||
        text.includes('business hours') || text.includes('office hours') || text.includes('أوقات') ||
        text.includes('24/7') || text.includes('24 hours') || text.includes('على مدار الساعة') ||
        /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*[-–]\s*(sun|mon|tue|wed|thu|fri|sat)/i.test(document.body.innerText) ||
        /\b\d{1,2}\s*(am|pm)\s*[-–]\s*\d{1,2}\s*(am|pm)\b/i.test(document.body.innerText);
      const is247 = text.includes('24/7') || text.includes('24 hours') || text.includes('على مدار الساعة') || text.includes('round the clock');
      return { hasHours, is247 };
    });
    const ss = ssPath(auditJobId, '40');
    await viewportShot(page, ss.abs);
    const passed = hours.hasHours || hours.is247;
    results.push(makeResult('Q40', {
      scoreEarned: passed ? 1 : 0,
      status: passed ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: `Working hours listed: ${hours.hasHours ? 'Yes' : 'No'}${hours.is247 ? ' (24/7 availability)' : ''}.`,
      recommendation: passed ? '' : getRecommendation('Q40'),
    }));
  }

  // Q41 — support available during stated hours (needs a live check) → manual
  results.push(makeResult('Q41', {
    status: 'na',
    notes: 'Requires contacting live chat during the posted hours and confirming an agent responds — deferred to the interactive/screen-record phase.',
  }));

  // ── Q42 + conversation block ──
  if (!SUBMIT_TEST_QUERY) {
    // Gated off: open the widget on the current page for a screenshot only.
    const ss = ssPath(auditJobId, '42');
    const adapter = await detectPlatform(page);
    let opened = false;
    if (adapter) {
      const launcher = await findLauncher(page, adapter);
      if (launcher) {
        await launcher.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(2500);
        opened = true;
      }
    }
    const compose = adapter ? await findCompose(page, adapter) : null;
    await viewportShot(page, ss.abs);
    results.push(makeResult('Q42', {
      status: 'na',
      screenshotPath: ss.rel,
      notes: opened
        ? (compose
            ? 'Chat widget opened and a compose box is reachable. Query submission is gated (SITECHECK_LIVECHAT_SUBMIT=1) to avoid messaging a live support desk on unattended runs.'
            : 'Chat widget opened but no compose box was found automatically.')
        : 'Chat detected but could not open the widget automatically — verify submission in the interactive phase.',
    }));
    for (const qid of conversationOrder) {
      results.push(makeResult(qid, { status: 'na', notes: INTERACTIVE_NA }));
    }
    return results;
  }

  // Gated ON: run the recorded conversation session.
  const browser = page.context().browser();
  const session = browser
    ? await conductChatSession(browser, url, auditJobId)
    : null;

  // Q42 — query submitted successfully (max 3)
  {
    const ss = ssPath(auditJobId, '42');
    await viewportShot(page, ss.abs); // widget context on the main page for evidence
    const submitted = !!session?.submitted;
    results.push(makeResult('Q42', {
      scoreEarned: submitted ? 3 : 0,
      status: submitted ? 'pass' : 'fail',
      screenshotPath: ss.rel,
      notes: submitted
        ? `Test query submitted successfully via the ${session?.platformId ?? 'detected'} chat widget.${session?.videoRel ? ' Session recorded.' : ''}`
        : `Could not submit a test query. ${session?.error ?? 'Widget did not expose a reachable compose box.'}`,
      recommendation: submitted ? '' : getRecommendation('Q42'),
    }));
  }

  // If we never got a working conversation, mark the rest NA and stop.
  if (!session || !session.submitted || session.transcript.length === 0) {
    const reason = session?.error
      ? `Conversation could not be completed automatically (${session.error}) — assess in the interactive phase.`
      : 'No transcript could be captured from the chat widget — assess in the interactive phase.';
    for (const qid of conversationOrder) {
      results.push(makeResult(qid, { status: 'na', notes: reason }));
    }
    return results;
  }

  // Q43 — support type (virtual / human), max 3
  {
    const isVirtual = session.agentType === 'virtual';
    const isHuman = session.agentType === 'human';
    results.push(makeResult('Q43', {
      scoreEarned: isVirtual || isHuman ? 3 : 0,
      status: isVirtual || isHuman ? 'pass' : 'na',
      screenshotPath: session.videoRel,
      notes: isVirtual
        ? `Virtual assistant (AI bot) — first reply in ${session.firstReplyMs !== null ? (session.firstReplyMs / 1000).toFixed(1) + 's' : 'n/a'}.`
        : isHuman
          ? `Human agent detected (reply latency ${session.firstReplyMs !== null ? (session.firstReplyMs / 1000).toFixed(1) + 's' : 'n/a'}).`
          : 'Could not determine the support type — no reply was received.',
    }));
  }

  // Q44b — human-agent response time (applies to human agents only)
  results.push(makeResult('Q44b', {
    status: 'na',
    notes: session.agentType === 'virtual'
      ? 'Agent was a virtual assistant — the human-agent response-time criterion does not apply.'
      : 'Human-agent response time is assessed in the interactive/screen-record phase.',
  }));

  // Q45–Q52c — conversation quality, judged by the LLM over the transcript.
  if (session.agentType !== 'virtual') {
    // We only auto-converse with bots; a human chat is captured for manual review.
    const reason = 'A human agent was engaged; soft-skill judgement is deferred to manual/screen-record review (the video and transcript are captured).';
    for (const qid of conversationOrder.filter(q => q !== 'Q43' && q !== 'Q44b')) {
      results.push(makeResult(qid, { status: 'na', notes: reason }));
    }
    return results;
  }

  const specs = conversationSpecs(language);
  const judge = await judgeTranscript({
    entityName,
    language,
    transcript: session.transcript,
    questions: specs.map(({ id, criterion, scale }) => ({ id, criterion, scale })),
  });

  if (!judge.available) {
    const reason = judge.provider === 'off'
      ? 'LLM judging is disabled (LIVECHAT_LLM_PROVIDER=off) — soft-skill questions require manual review.'
      : `LLM judgment unavailable via "${judge.provider}"${judge.error ? ` (${judge.error})` : ''}. ` +
        `Start a local model (e.g. \`ollama run llama3.1\`) or set LIVECHAT_LLM_PROVIDER=anthropic. Transcript and video are captured for manual review.`;
    for (const spec of specs) {
      results.push(makeResult(spec.id, { status: 'na', notes: reason, screenshotPath: session.videoRel }));
    }
    return results;
  }

  const verdictById = new Map(judge.verdicts.map(v => [v.id, v]));
  for (const spec of specs) {
    const res = verdictToResult(spec, verdictById.get(spec.id));
    if (!res.screenshotPath) res.screenshotPath = session.videoRel;
    results.push(res);
  }

  return results;
}
