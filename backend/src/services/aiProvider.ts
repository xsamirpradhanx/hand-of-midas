import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';

const geminiClient = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const groqClient = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

export const AI_AVAILABLE = Boolean(geminiClient || groqClient);

interface GenerateTextOptions {
  /** Ask for a raw JSON response body (both providers support this natively). */
  json?: boolean;
}

// The screener fans out ~20 symbols per run, each issuing up to 3 AI calls
// (narrative classify, committee synthesis, trade narrative) — enough to blow
// through both Gemini's and Groq's free-tier rate limits in one burst. Serialize
// every call (Gemini or Groq) through one queue with spacing between dispatches.
const MIN_INTERVAL_MS = 2100; // ~28 calls/min ceiling, safely under typical free-tier RPM limits
let queueTail: Promise<void> = Promise.resolve();
let lastDispatchAt = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const wait = Math.max(0, lastDispatchAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastDispatchAt = Date.now();
  });
  queueTail = run.catch(() => {});
  return run.then(fn);
}

/**
 * Tries Gemini first, then falls back to Groq on any failure (quota, network, etc).
 * Returns null if neither provider is configured or both calls fail.
 * All calls are throttled through a shared queue to stay under provider rate limits.
 */
export async function generateText(prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
  return throttled(() => generateTextNow(prompt, options));
}

async function generateTextNow(prompt: string, options: GenerateTextOptions): Promise<string | null> {
  if (geminiClient) {
    try {
      const response = await geminiClient.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
        ...(options.json ? { config: { responseMimeType: 'application/json' } } : {}),
      });
      if (response.text) return response.text;
    } catch (err) {
      console.warn('[AIProvider] Gemini failed, falling back to Groq:', err);
    }
  }

  if (groqClient) {
    try {
      const completion = await groqClient.chat.completions.create({
        // llama-3.3-70b-versatile was retired from Groq's catalog (404
        // model_not_found on every call — verified against GET
        // /openai/v1/models). This was the fallback for when Gemini's
        // free-tier quota is exhausted, so with it broken too, every AI-backed
        // factor (catalyst sentiment, committee synthesis, narrative
        // classification) was silently degrading to heuristics on quota days.
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        ...(options.json ? { response_format: { type: 'json_object' as const } } : {}),
      });
      const text = completion.choices[0]?.message?.content;
      if (text) return text;
    } catch (err) {
      console.warn('[AIProvider] Groq failed:', err);
    }
  }

  return null;
}
