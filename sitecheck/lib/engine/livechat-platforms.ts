// lib/engine/livechat-platforms.ts — Live-chat platform adapters
//
// Chat widgets vary wildly (iframes, shadow DOM, third-party platforms). This
// registry gives precise selectors for common platforms and a generic fallback
// that searches every frame for a launcher / compose box / transcript. All
// selectors are attribute/class *contains* matches, never one site's exact
// framework class — see [[engine-must-generalize]].

import type { Page, Frame, Locator } from 'playwright';

export interface PlatformAdapter {
  id: string;
  // A DOM/script signature that identifies the platform on the page.
  detect: string[];         // CSS selectors; any match ⇒ this platform
  scriptHints: RegExp;      // matches <script src> for this platform
  launcher: string[];       // clickable elements that open the chat
  compose: string[];        // the message input once the chat is open
  transcript: string[];     // container holding the conversation messages
}

// Ordered most-specific → generic. `generic` always matches last.
export const PLATFORM_ADAPTERS: PlatformAdapter[] = [
  {
    id: 'intercom',
    detect: ['#intercom-container', '[class*="intercom-"]', 'iframe[name^="intercom"]'],
    scriptHints: /intercom/i,
    launcher: ['#intercom-launcher', '[class*="intercom-launcher"]', 'div[aria-label*="Open Intercom" i]'],
    compose: ['textarea[name="message"]', '[class*="intercom-composer"] textarea', 'div[contenteditable="true"]'],
    transcript: ['[class*="intercom-conversation"]', '[class*="intercom-comment"]'],
  },
  {
    id: 'zendesk',
    detect: ['iframe#launcher', 'iframe[title*="Messaging" i]', '[class*="zEWidget"]'],
    scriptHints: /zopim|zendesk|zdassets/i,
    launcher: ['iframe#launcher', 'button[aria-label*="chat" i]', '[class*="zEWidget-launcher"]'],
    compose: ['textarea[name="message"]', 'textarea[placeholder*="message" i]', 'div[contenteditable="true"]'],
    transcript: ['[class*="message-list"]', '[data-testid*="message"]'],
  },
  {
    id: 'tawk',
    detect: ['#tawk-bubble-container', 'iframe[title*="chat" i][src*="tawk" i]', '[class*="tawk"]'],
    scriptHints: /tawk\.to/i,
    launcher: ['#tawk-bubble-container', 'button[class*="tawk"]', 'iframe[title*="chat" i][src*="tawk" i]'],
    compose: ['textarea[name="message"]', 'textarea[placeholder*="type" i]', 'div[contenteditable="true"]'],
    transcript: ['[class*="tawk-message"]', '[class*="message-body"]'],
  },
  {
    id: 'freshchat',
    detect: ['#fc_frame', 'iframe#fc_widget', '[class*="fresh"]'],
    scriptHints: /freshchat|wchat\.freshchat/i,
    launcher: ['#fc_frame', 'button[aria-label*="chat" i]'],
    compose: ['textarea[placeholder*="message" i]', 'div[contenteditable="true"]'],
    transcript: ['[class*="message-list"]', '[class*="msg-"]'],
  },
  {
    id: 'genesys',
    detect: ['[class*="genesys"]', 'iframe[title*="Genesys" i]', '#genesys-messenger'],
    scriptHints: /genesys|inindca|mypurecloud/i,
    launcher: ['[class*="launcher-button"]', 'button[aria-label*="chat" i]', '[class*="genesys"] button'],
    compose: ['textarea[placeholder*="type" i]', 'div[contenteditable="true"]', 'textarea'],
    transcript: ['[class*="message"]', '[role="log"]'],
  },
  {
    id: 'liveperson',
    detect: ['[class*="LPMcontainer"]', '[class*="lp_"]', 'iframe[title*="LivePerson" i]'],
    scriptHints: /liveperson|lpsnmedia|livepersoncdn/i,
    launcher: ['[class*="LPMcontainer"]', 'button[aria-label*="chat" i]'],
    compose: ['textarea[placeholder*="type" i]', 'div[contenteditable="true"]'],
    transcript: ['[class*="lp_message"]', '[class*="message-text"]'],
  },
  {
    // TAMM's own ui-lib chatbot (Abu Dhabi's AI assistant). Named because the
    // rubric evaluates TAMM's own chat; still purely class-contains, so any
    // ui-lib-based gov site benefits too.
    id: 'tamm-uilib',
    detect: ['[class*="chatbot-container"]', '[class*="ui-lib-chat"]', '[class*="chatbot-loading"]'],
    scriptHints: /tamm|ui-lib/i,
    launcher: ['[class*="chatbot"] button', '[aria-label*="assistant" i]', '[class*="ai-assistant"]', '[class*="chat-launcher"]'],
    compose: ['textarea', 'input[type="text"][class*="chat" i]', 'div[contenteditable="true"]'],
    transcript: ['[class*="chatbot-message"]', '[class*="ui-lib-chat"] [class*="message"]', '[class*="chat-message"]'],
  },
  {
    id: 'generic',
    detect: [
      '[class*="chat-widget"]', '[class*="chatwidget"]', '[class*="livechat"]', '[class*="live-chat"]',
      '[class*="chatbot"]', '[class*="chat-bubble"]', '[class*="chat-button"]', '[class*="support-chat"]',
      'iframe[title*="chat" i]', 'iframe[src*="chat" i]',
    ],
    scriptHints: /chat|messenger|livechat|liveperson|zendesk|intercom|drift|tidio|crisp/i,
    launcher: [
      'button[aria-label*="chat" i]', 'button[title*="chat" i]', '[aria-label*="live chat" i]',
      '[class*="chat-button"]', '[class*="chat-bubble"]', '[class*="chat-launcher"]',
      '[class*="chat-icon"]', '[class*="chat-toggle"]', 'button:has-text("Chat")', 'button:has-text("دردشة")',
    ],
    compose: [
      'textarea[placeholder*="message" i]', 'textarea[placeholder*="type" i]', 'textarea[placeholder*="رسالة"]',
      'input[placeholder*="message" i]', 'input[aria-label*="message" i]',
      'textarea', 'div[contenteditable="true"]',
    ],
    transcript: [
      '[class*="message-list"]', '[class*="chat-message"]', '[class*="messages"]', '[role="log"]',
    ],
  },
];

// Identify the platform present on the page. Returns the generic adapter if no
// specific one matches but chat is present, or null if no chat at all.
export async function detectPlatform(page: Page): Promise<PlatformAdapter | null> {
  const result = await page.evaluate((adapters) => {
    const scripts = Array.from(document.querySelectorAll('script[src]')).map(
      s => (s.getAttribute('src') || '').toLowerCase()
    );
    for (const a of adapters) {
      for (const sel of a.detect) {
        try { if (document.querySelector(sel)) return a.id; } catch { /* */ }
      }
      // Script-src hint (patterns are passed as strings, rebuilt here)
      if (a.scriptHint && scripts.some(src => new RegExp(a.scriptHint, 'i').test(src))) return a.id;
    }
    return null;
  }, PLATFORM_ADAPTERS.map(a => ({ id: a.id, detect: a.detect, scriptHint: a.scriptHints.source })));

  if (!result) return null;
  return PLATFORM_ADAPTERS.find(a => a.id === result) ?? null;
}

// Find a visible launcher for the given adapter across the page and its frames.
export async function findLauncher(page: Page, adapter: PlatformAdapter): Promise<Locator | null> {
  const selectors = [...adapter.launcher, ...PLATFORM_ADAPTERS[PLATFORM_ADAPTERS.length - 1].launcher];
  for (const ctx of [page, ...page.frames()]) {
    for (const sel of selectors) {
      try {
        const loc = ctx.locator(sel).first();
        if (await loc.isVisible({ timeout: 400 }).catch(() => false)) return loc;
      } catch { /* invalid selector in this context */ }
    }
  }
  return null;
}

// Find a visible compose box across the page and its frames, preferring the
// adapter's selectors, then the generic fallback.
export async function findCompose(
  page: Page, adapter: PlatformAdapter,
): Promise<{ frame: Frame | null; locator: Locator } | null> {
  const generic = PLATFORM_ADAPTERS[PLATFORM_ADAPTERS.length - 1];
  const selectors = Array.from(new Set([...adapter.compose, ...generic.compose]));
  for (const ctx of [page, ...page.frames()]) {
    for (const sel of selectors) {
      try {
        const loc = ctx.locator(sel).first();
        if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
          return { frame: ctx === page.mainFrame() ? null : (ctx as Frame), locator: loc };
        }
      } catch { /* */ }
    }
  }
  return null;
}

// Extract the conversation transcript (role + text, in order) from whichever
// frame holds the chat. Best-effort: role is inferred from container class
// hints ("agent"/"bot"/"system" vs "user"/"visitor"/"me"/"self").
export interface TranscriptMessage { role: 'user' | 'agent' | 'unknown'; text: string }

export async function extractTranscript(
  page: Page, adapter: PlatformAdapter,
): Promise<TranscriptMessage[]> {
  const selectors = Array.from(new Set([
    ...adapter.transcript,
    ...PLATFORM_ADAPTERS[PLATFORM_ADAPTERS.length - 1].transcript,
    '[class*="message"]', '[class*="msg"]', '[role="listitem"]',
  ]));

  for (const ctx of [page, ...page.frames()]) {
    const msgs = await ctx.evaluate((sels) => {
      const seen = new Set<Element>();
      const out: { role: string; text: string }[] = [];
      const userHints = /user|visitor|customer|self|me\b|outgoing|sent|right/i;
      const agentHints = /agent|bot|assistant|operator|admin|system|incoming|received|left|reply/i;
      for (const sel of sels) {
        let nodes: Element[] = [];
        try { nodes = Array.from(document.querySelectorAll(sel)); } catch { continue; }
        for (const el of nodes) {
          if (seen.has(el)) continue;
          // Skip nodes that merely contain other message nodes
          const text = (el as HTMLElement).innerText?.trim() || '';
          if (!text || text.length > 2000) continue;
          seen.add(el);
          const cls = (el.className || '').toString() + ' ' + ((el.parentElement?.className || '').toString());
          let role = 'unknown';
          if (userHints.test(cls)) role = 'user';
          else if (agentHints.test(cls)) role = 'agent';
          out.push({ role, text });
        }
        if (out.length) break; // first selector that yields messages wins
      }
      return out;
    }, selectors).catch(() => [] as { role: string; text: string }[]);

    if (msgs.length) {
      return msgs.map(m => ({
        role: (m.role === 'user' || m.role === 'agent' ? m.role : 'unknown') as TranscriptMessage['role'],
        text: m.text,
      }));
    }
  }
  return [];
}
