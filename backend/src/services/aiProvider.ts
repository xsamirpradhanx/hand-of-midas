import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';

const geminiClient = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const groqClient = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

export const AI_AVAILABLE = Boolean(geminiClient || groqClient);

interface GenerateTextOptions {
  /** Ask for a raw JSON response body (both providers support this natively). */
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Per-provider rate limiting
// ---------------------------------------------------------------------------

/**
 * Requests-per-minute ceilings, per provider.
 *
 * This used to be ONE global 2,100 ms queue shared by both providers — ~28
 * calls/min. Gemini's free tier allows **5 requests per minute** for
 * gemini-3.5-flash (the 429 states `limit: 5`,
 * `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`), so the shared queue
 * was pacing at 5.7x Gemini's actual ceiling and every burst — opening the app
 * fans the screener across ~20 symbols, each issuing up to 3 AI calls — hit
 * RESOURCE_EXHAUSTED within seconds.
 *
 * One shared interval cannot serve two providers with different ceilings, so
 * each gets its own. Overridable per deployment because these are free-tier
 * numbers that change: raise them after a paid upgrade rather than editing code.
 */
function envRpm(key: string, fallback: number): number {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * How long a caller will wait for a dispatch slot before giving up.
 *
 * Every call site has a deterministic fallback (keyword sentiment scan, the
 * committee's deterministic summary, ticker-keyword archetype). A deterministic
 * answer now beats an AI answer four minutes from now, and a screener pass over
 * twenty symbols can queue far past that. Returning null here is not an error
 * path — it is the designed degradation.
 */
const MAX_QUEUE_WAIT_MS = Number(process.env['AI_MAX_QUEUE_WAIT_MS']) || 90_000;

interface ProviderLimiter {
  readonly name: string;
  readonly minIntervalMs: number;
  /** Earliest wall-clock time this provider may dispatch again. */
  nextFreeAt: number;
  /** While in the future, the provider is skipped entirely — see tripBreaker. */
  cooldownUntil: number;
  /** Consecutive rate-limit trips, used to escalate the cooldown. */
  trips: number;
  /** Whether the currently-open breaker has already been logged once. */
  breakerLogged: boolean;
}

function makeLimiter(name: string, rpm: number): ProviderLimiter {
  return {
    name,
    minIntervalMs: Math.ceil(60_000 / rpm),
    nextFreeAt: 0,
    cooldownUntil: 0,
    trips: 0,
    breakerLogged: false,
  };
}

const limiters: Record<string, ProviderLimiter> = {
  gemini: makeLimiter('gemini', envRpm('GEMINI_RPM', 5)),
  groq: makeLimiter('groq', envRpm('GROQ_RPM', 25)),
};

/**
 * Escalating cooldowns after consecutive 429s.
 *
 * The provider's own `retryDelay` is a per-minute hint (Gemini returns ~2s) and
 * is useless when the *daily* quota is what ran out: retrying every 2 seconds
 * against an exhausted RPD burns the rest of the session re-failing. Each
 * consecutive trip escalates, and a success resets the ladder.
 */
const COOLDOWN_LADDER_MS = [15_000, 60_000, 5 * 60_000, 30 * 60_000];
/** A per-day quota cannot recover within the session; stop asking for an hour. */
const DAILY_QUOTA_COOLDOWN_MS = 60 * 60_000;

function isRateLimited(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 429) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('RESOURCE_EXHAUSTED') || message.includes('rate_limit');
}

/** True when the 429 is a per-DAY quota rather than a per-minute one. */
function isDailyQuota(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /PerDay|per day|PerProjectPerDay|Daily/i.test(message);
}

/**
 * Provider-suggested wait, in ms. Gemini embeds
 * `{"@type":".../RetryInfo","retryDelay":"2s"}` in the error body; Groq (and
 * most HTTP APIs) send a `retry-after` header in seconds.
 */
function suggestedRetryMs(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const retryDelay = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (retryDelay) return Math.ceil(Number(retryDelay[1]) * 1000);

  const headers = (err as { headers?: Headers } | null)?.headers;
  const retryAfter = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Math.ceil(Number(retryAfter) * 1000);

  return 0;
}

function tripBreaker(limiter: ProviderLimiter, err: unknown): void {
  limiter.trips += 1;
  const ladder = COOLDOWN_LADDER_MS[Math.min(limiter.trips - 1, COOLDOWN_LADDER_MS.length - 1)]!;
  const cooldownMs = isDailyQuota(err)
    ? DAILY_QUOTA_COOLDOWN_MS
    : Math.max(ladder, suggestedRetryMs(err));

  limiter.cooldownUntil = Date.now() + cooldownMs;

  // One line, once per open breaker. This used to log the provider's entire
  // error object — a ten-line stack trace — on every single throttled call,
  // which is what made a rate limit look like a crash in the server output.
  if (!limiter.breakerLogged) {
    console.warn(
      `[AIProvider] ${limiter.name} rate-limited; skipping it for ${Math.round(cooldownMs / 1000)}s ` +
      `(trip ${limiter.trips}${isDailyQuota(err) ? ', daily quota' : ''}). Other providers and deterministic fallbacks still serve.`,
    );
    limiter.breakerLogged = true;
  }
}

function clearBreaker(limiter: ProviderLimiter): void {
  limiter.trips = 0;
  limiter.cooldownUntil = 0;
  limiter.breakerLogged = false;
}

/**
 * Reserve the next dispatch slot on whichever eligible provider can serve
 * soonest, and return how long the caller must wait for it.
 *
 * Synchronous on purpose: with no `await` between reading `nextFreeAt` and
 * writing it back, two concurrent callers can never be handed the same slot.
 * This is what lets the burst spread across providers instead of stacking on
 * one queue — Gemini takes 5/min, Groq absorbs the rest, and nothing 429s.
 */
function reserveSlot(candidates: string[]): { limiter: ProviderLimiter; waitMs: number } | null {
  const now = Date.now();
  let best: { limiter: ProviderLimiter; availableAt: number } | null = null;

  for (const key of candidates) {
    const limiter = limiters[key]!;
    if (limiter.cooldownUntil > now) continue;
    if (limiter.cooldownUntil !== 0) clearBreaker(limiter); // cooldown elapsed
    const availableAt = Math.max(now, limiter.nextFreeAt);
    if (!best || availableAt < best.availableAt) best = { limiter, availableAt };
  }

  if (!best) return null;
  const waitMs = best.availableAt - now;
  if (waitMs > MAX_QUEUE_WAIT_MS) return null;

  best.limiter.nextFreeAt = best.availableAt + best.limiter.minIntervalMs;
  return { limiter: best.limiter, waitMs };
}

/**
 * Tries providers in order of who can serve soonest, honouring each one's own
 * rate limit and skipping any whose breaker is open. Returns null if no
 * provider is configured, all are cooling down, none can serve within
 * MAX_QUEUE_WAIT_MS, or every attempt failed — callers fall back to their
 * deterministic path.
 */
export async function generateText(prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
  const remaining: string[] = [];
  if (geminiClient) remaining.push('gemini');
  if (groqClient) remaining.push('groq');

  while (remaining.length > 0) {
    const reservation = reserveSlot(remaining);
    if (!reservation) return null;

    const { limiter, waitMs } = reservation;
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

    try {
      const text = limiter.name === 'gemini'
        ? await callGemini(prompt, options)
        : await callGroq(prompt, options);
      if (text) {
        clearBreaker(limiter);
        return text;
      }
      // Answered, but empty. Not a rate limit — don't trip the breaker, just
      // let the next provider try.
    } catch (err) {
      if (isRateLimited(err)) {
        tripBreaker(limiter, err);
      } else {
        console.warn(`[AIProvider] ${limiter.name} failed:`, err instanceof Error ? err.message : err);
      }
    }

    remaining.splice(remaining.indexOf(limiter.name), 1);
  }

  return null;
}

async function callGemini(prompt: string, options: GenerateTextOptions): Promise<string | null> {
  const response = await geminiClient!.models.generateContent({
    model: process.env['GEMINI_MODEL'] || 'gemini-3.5-flash',
    contents: prompt,
    ...(options.json ? { config: { responseMimeType: 'application/json' } } : {}),
  });
  return response.text ?? null;
}

async function callGroq(prompt: string, options: GenerateTextOptions): Promise<string | null> {
  const completion = await groqClient!.chat.completions.create({
    // llama-3.3-70b-versatile was retired from Groq's catalog (404
    // model_not_found on every call — verified against GET
    // /openai/v1/models). This was the fallback for when Gemini's
    // free-tier quota is exhausted, so with it broken too, every AI-backed
    // factor (catalyst sentiment, committee synthesis, narrative
    // classification) was silently degrading to heuristics on quota days.
    model: process.env['GROQ_MODEL'] || 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: prompt }],
    ...(options.json ? { response_format: { type: 'json_object' as const } } : {}),
  });
  return completion.choices[0]?.message?.content ?? null;
}

/** Test/diagnostic hook — resets every limiter to its initial state. */
export function __resetAiLimitersForTest(): void {
  for (const key of Object.keys(limiters)) {
    const limiter = limiters[key]!;
    limiter.nextFreeAt = 0;
    clearBreaker(limiter);
  }
}
