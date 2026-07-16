// lib/engine/enquiry-inbox.ts — IMAP reader for enquiry replies (Pillar 10)
//
// Provider-agnostic: connects to any standard mailbox (Gmail, Outlook, custom
// domain) with an app-password over IMAP. Credentials come from .env, set by the
// user — never typed into a website. Used by scripts/poll-enquiries.ts.
//
//   ENQUIRY_IMAP_HOST   e.g. imap.gmail.com
//   ENQUIRY_IMAP_PORT   default 993
//   ENQUIRY_IMAP_USER   default = ENQUIRY_TEST_EMAIL
//   ENQUIRY_IMAP_PASS   app password
//   ENQUIRY_IMAP_TLS    default true (set "0" for STARTTLS/plain on 143)

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface EmailMsg {
  from: string;        // full "Name <addr>"
  fromAddress: string; // just the address
  fromDomain: string;  // domain of the address
  subject: string;
  date: Date;
  text: string;        // plain-text body (html stripped if needed)
}

export interface InboxConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export function inboxConfigFromEnv(): InboxConfig | null {
  const host = process.env.ENQUIRY_IMAP_HOST;
  const user = process.env.ENQUIRY_IMAP_USER || process.env.ENQUIRY_TEST_EMAIL;
  const pass = process.env.ENQUIRY_IMAP_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.ENQUIRY_IMAP_PORT || 993),
    secure: process.env.ENQUIRY_IMAP_TLS !== '0',
    user,
    pass,
  };
}

function domainOf(addr: string): string {
  const m = addr.match(/@([^\s>]+)/);
  return m ? m[1].toLowerCase() : '';
}

export interface FetchResult { ok: boolean; messages: EmailMsg[]; error?: string }

// Fetch inbox messages received on/after `since`, parsed and sorted oldest-first.
export async function fetchReplies(cfg: InboxConfig, since: Date): Promise<FetchResult> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  const messages: EmailMsg[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // IMAP SINCE has day granularity; refine by internalDate below.
      for await (const msg of client.fetch({ since }, { source: true, internalDate: true })) {
        try {
          const parsed = await simpleParser(msg.source as Buffer);
          const date = parsed.date || msg.internalDate || new Date();
          if (date < new Date(since.getTime() - 60_000)) continue; // guard day-rounding
          const fromText = parsed.from?.text || '';
          const fromAddress = parsed.from?.value?.[0]?.address || '';
          const text = (parsed.text || parsed.html || '').toString().replace(/\s+\n/g, '\n').trim();
          messages.push({
            from: fromText,
            fromAddress,
            fromDomain: domainOf(fromAddress || fromText),
            subject: parsed.subject || '',
            date,
            text,
          });
        } catch { /* skip unparseable message */ }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    messages.sort((a, b) => a.date.getTime() - b.date.getTime());
    return { ok: true, messages };
  } catch (err) {
    try { await client.logout(); } catch { /* */ }
    return { ok: false, messages: [], error: err instanceof Error ? err.message : String(err) };
  }
}
