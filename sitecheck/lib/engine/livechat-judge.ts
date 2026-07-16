// lib/engine/livechat-judge.ts — LLM judge for live-chat transcripts
//
// The soft-skill questions in Pillar 9 (greeting, tone, language, grammar,
// helpfulness, accuracy…) can't be scored by DOM heuristics — they need a
// language model to read the captured conversation. To keep the beta free of
// API cost, the judge is PROVIDER-PLUGGABLE:
//
//   LIVECHAT_LLM_PROVIDER = 'ollama'    (default) — free, local, no credits
//                         | 'anthropic'           — Claude, for production
//                         | 'off'                 — skip; emit every Q as NA
//
// Ollama runs models locally (https://ollama.com) and exposes an HTTP API on
// localhost:11434 with native JSON-schema structured output — no SDK, no key,
// no cost. Point OLLAMA_MODEL at any pulled model (llama3.1 default; qwen2.5 is
// stronger for Arabic). Anthropic path is a drop-in upgrade later.
//
// Fail-safe by design: if no backend is reachable (Ollama not running, no key,
// network/parse error), judgeTranscript returns { available: false } and the
// pillar emits the soft-skill questions as NA rather than failing the run.

import type { TranscriptMessage } from './livechat-platforms';

// A question for the judge to assess against the transcript.
export interface JudgeQuestion {
  id: string;          // e.g. 'Q45'
  criterion: string;   // what to assess, in plain language
  scale: 'binary' | 'tiered'; // binary ⇒ yes/no; tiered ⇒ yes/partial/no
}

export interface JudgeVerdict {
  id: string;
  rating: 'yes' | 'partial' | 'no' | 'na';
  justification: string;
}

export interface JudgeResult {
  available: boolean;  // false ⇒ no backend; caller should emit NA
  provider: string;    // 'ollama' | 'anthropic' | 'off'
  verdicts: JudgeVerdict[];
  error?: string;
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          rating: { type: 'string', enum: ['yes', 'partial', 'no', 'na'] },
          justification: { type: 'string' },
        },
        required: ['id', 'rating', 'justification'],
      },
    },
  },
  required: ['verdicts'],
} as const;

function buildPrompt(params: {
  entityName: string;
  language: string;
  transcript: TranscriptMessage[];
  questions: JudgeQuestion[];
}): { system: string; user: string } {
  const { entityName, language, transcript, questions } = params;

  const convo = transcript.length
    ? transcript
        .map((m) => {
          const who = m.role === 'user' ? 'CUSTOMER' : m.role === 'agent' ? 'AGENT' : 'UNKNOWN';
          return `${who}: ${m.text}`;
        })
        .join('\n')
    : '(no messages were captured)';

  const questionLines = questions
    .map((q) => {
      const scaleNote =
        q.scale === 'binary'
          ? 'Answer "yes" or "no".'
          : 'Answer "yes" (fully met), "partial" (partially met), or "no" (not met).';
      return `- ${q.id}: ${q.criterion} ${scaleNote}`;
    })
    .join('\n');

  const system =
    'You are a meticulous quality evaluator for a government-service live-chat "mystery shopper" audit. ' +
    'You read a chat transcript between a customer (the tester) and a support agent (a virtual assistant/bot), ' +
    'then judge the AGENT\'s messages against each criterion. Judge only the agent, never the customer. ' +
    'Base every verdict strictly on what the transcript shows — do not assume behaviour that is not present. ' +
    'If the transcript lacks the evidence needed to judge a criterion, rate it "na". ' +
    'Return only the structured verdicts, one per question id, with a one-sentence justification each.';

  const user =
    `Entity under audit: ${entityName}\n` +
    `Expected/preferred customer language: ${language}\n\n` +
    `--- CHAT TRANSCRIPT ---\n${convo}\n--- END TRANSCRIPT ---\n\n` +
    `Assess each criterion below against the AGENT's messages:\n${questionLines}\n\n` +
    `Respond with a JSON object { "verdicts": [ { "id", "rating", "justification" } ] } ` +
    `containing exactly one entry per question id above.`;

  return { system, user };
}

// ---- Ollama (free, local) ---------------------------------------------------

async function judgeWithOllama(
  system: string,
  user: string,
): Promise<{ verdicts: JudgeVerdict[] }> {
  const base = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.1';

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: VERDICT_SCHEMA, // Ollama native structured output
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content || '';
  return JSON.parse(content) as { verdicts: JudgeVerdict[] };
}

// ---- Anthropic (production upgrade) ----------------------------------------

async function judgeWithAnthropic(
  system: string,
  user: string,
): Promise<{ verdicts: JudgeVerdict[] }> {
  // Imported lazily so the SDK is only loaded when this provider is selected.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const createArgs = {
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
  };
  const msg = (await client.messages.create(
    createArgs as Parameters<typeof client.messages.create>[0],
  )) as { content: Array<{ type: string; text?: string }> };

  const block = Array.isArray(msg.content)
    ? msg.content.find((b) => b.type === 'text')
    : undefined;
  const text = block?.text || '';
  return JSON.parse(text) as { verdicts: JudgeVerdict[] };
}

// ---- Public entry -----------------------------------------------------------

export async function judgeTranscript(params: {
  entityName: string;
  language: string;
  transcript: TranscriptMessage[];
  questions: JudgeQuestion[];
}): Promise<JudgeResult> {
  const provider = (process.env.LIVECHAT_LLM_PROVIDER || 'ollama').toLowerCase();

  if (provider === 'off') {
    return { available: false, provider, verdicts: [], error: 'LLM judging disabled' };
  }
  // Nothing to judge — don't spend a call.
  if (!params.transcript.length) {
    return { available: false, provider, verdicts: [], error: 'empty transcript' };
  }

  const { system, user } = buildPrompt(params);

  try {
    const { verdicts } =
      provider === 'anthropic'
        ? await judgeWithAnthropic(system, user)
        : await judgeWithOllama(system, user);

    // Keep only verdicts for questions we asked; coerce unknown ratings to na.
    const asked = new Set(params.questions.map((q) => q.id));
    const clean = (verdicts || [])
      .filter((v) => v && asked.has(v.id))
      .map((v) => ({
        id: v.id,
        rating: (['yes', 'partial', 'no', 'na'].includes(v.rating) ? v.rating : 'na') as JudgeVerdict['rating'],
        justification: (v.justification || '').toString().slice(0, 500),
      }));

    return { available: clean.length > 0, provider, verdicts: clean };
  } catch (err) {
    return {
      available: false,
      provider,
      verdicts: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
