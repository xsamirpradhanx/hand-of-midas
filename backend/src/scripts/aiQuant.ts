import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.join(__dirname, '../..');
const FACTORS_DIR = path.join(__dirname, '../services/factors');
const REGISTRY_PATH = path.join(FACTORS_DIR, 'factorRegistry.ts');

import { getItem } from '../services/dynamodb.js';
import type { FactorStatsItem } from '../types.js';
import type { PredictiveFactor, FactorInput } from '../services/factors/types.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Hand-tuned factors top out at weight 0.35 (see factors/volumeProfile.ts). A
// freshly generated factor has zero live track record, so it must never be
// able to out-weigh every reviewed factor in the engine — enforced below both
// by prompting the model and by validating what it actually produced.
const MAX_GENERATED_WEIGHT = 0.35;

/**
 * Models tried in order. The single pinned alias this used to hardcode made the
 * whole run fail on any transient capacity blip: `gemini-flash-latest` answers a
 * trivial prompt fine but returned 503 UNAVAILABLE on three consecutive factor
 * generations, because this prompt is far heavier than a ping. As a scheduled
 * job, dying on a temporary spike means silently skipping a generation cycle.
 */
const MODEL_CHAIN = [
  'gemini-flash-latest',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
];

const GENERATION_ATTEMPTS_PER_MODEL = 3;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generate with exponential backoff, falling through MODEL_CHAIN.
 *
 * Retries only errors that a retry can actually fix. A 404 (model not available
 * to this key) or 429 (quota exhausted) will not resolve by waiting, so those
 * skip straight to the next model instead of burning the backoff budget —
 * observed live: gemini-2.5-flash 404s and gemini-pro-latest 429s on this key.
 */
async function generateWithFallback(prompt: string): Promise<string> {
  let lastError: unknown;

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const response = await ai.models.generateContent({ model, contents: prompt });
        const text = response.text;
        if (!text) throw new Error('Model returned an empty response.');
        if (model !== MODEL_CHAIN[0] || attempt > 0) {
          console.log(`[AI Quant] ↩︎ Succeeded on ${model} (attempt ${attempt + 1}).`);
        }
        return text;
      } catch (err: any) {
        lastError = err;
        const status = err?.status;

        if (status === 404 || status === 400 || status === 429) {
          console.warn(`[AI Quant] ⚠️ ${model} unusable (${status}); trying next model.`);
          break;
        }

        const backoffMs = 2000 * Math.pow(2, attempt);
        console.warn(
          `[AI Quant] ⚠️ ${model} attempt ${attempt + 1}/${GENERATION_ATTEMPTS_PER_MODEL} failed` +
          `${status ? ` (${status})` : ''}; retrying in ${backoffMs / 1000}s.`,
        );
        if (attempt < GENERATION_ATTEMPTS_PER_MODEL - 1) await sleep(backoffMs);
      }
    }
  }

  throw new Error(
    `All ${MODEL_CHAIN.length} models failed. Last error: ` +
    `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Builds a plausible-looking synthetic OHLCV series so a freshly generated
 * factor's evaluate() can be smoke-tested without hitting a real data
 * provider. Deterministic (no Math.random) so failures are reproducible.
 */
type SyntheticRegime = 'oscillating' | 'uptrend' | 'downtrend';

function buildSyntheticBars(length: number, regime: SyntheticRegime = 'oscillating'): FactorInput['bars'] {
  const bars: FactorInput['bars'] = [];
  let price = 100;
  for (let i = 0; i < length; i++) {
    // Deterministic pseudo-oscillation so entropy/efficiency-style factors
    // see non-degenerate (non-flat, non-monotonic) input.
    const wobble = Math.sin(i / 7) * 1.5 + Math.cos(i / 3) * 0.5;
    // A single regime only ever exercises one branch of a directional factor,
    // so sweep a trend in each direction as well. (Note: this is defence in
    // depth for future factors, not what let the inverted-target bug through —
    // that factor reads bullish on oscillating data too, so the ordering check
    // in checkFactorResult would have caught it on the original single regime.
    // The gap was the missing check, not the missing regimes.)
    const trend = regime === 'uptrend' ? 0.8 : regime === 'downtrend' ? -0.8 : 0;
    const drift = wobble + trend;
    const open = price;
    const close = Math.max(1, price + drift);
    const high = Math.max(open, close) + Math.abs(drift) * 0.5 + 0.25;
    const low = Math.min(open, close) - Math.abs(drift) * 0.5 - 0.25;
    const volume = 1_000_000 + (i % 11) * 150_000;
    bars.push({ datetime: new Date(2024, 0, i + 1).toISOString(), open, high, low, close, volume });
    price = close;
  }
  return bars;
}

/**
 * Validates a freshly generated factor beyond "does it instantiate": runs it
 * against synthetic data and checks the FactorResult shape/bounds actually
 * respected by the rest of the engine (bucket, correlationGroup, weight
 * ceiling). Returns a list of problems; empty means the factor passed.
 */
async function validateGeneratedFactor(instance: PredictiveFactor): Promise<string[]> {
  const problems: string[] = [];

  if (instance.bucket !== 'MOMENTUM') {
    problems.push(`bucket must be 'MOMENTUM' for AI-generated factors, got '${instance.bucket}'.`);
  }
  if (!instance.correlationGroup) {
    problems.push('correlationGroup is required so correlated AI factors de-duplicate instead of stacking.');
  }

  // Sweep every regime so both the bullish and bearish branches are exercised.
  const regimes: SyntheticRegime[] = ['oscillating', 'uptrend', 'downtrend'];
  const results: { regime: SyntheticRegime; result: Awaited<ReturnType<PredictiveFactor['evaluate']>> }[] = [];

  for (const regime of regimes) {
    const bars = buildSyntheticBars(60, regime);
    const sampleInput: FactorInput = { symbol: 'TEST', currentPrice: bars[bars.length - 1].close, bars };
    try {
      results.push({ regime, result: await instance.evaluate(sampleInput) });
    } catch (err) {
      problems.push(`evaluate() threw on ${regime} synthetic input: ${err instanceof Error ? err.message : String(err)}`);
      return problems;
    }
  }

  // A factor that abstains on every regime is acceptable — real market data may
  // still trigger it — but there is then nothing further to check.
  if (results.every(r => r.result === null)) return problems;

  for (const { regime, result } of results) {
    if (result === null) continue;
    problems.push(...checkFactorResult(result, regime));
  }

  return problems;
}

/** Shape and semantic checks applied to one FactorResult. */
function checkFactorResult(
  result: NonNullable<Awaited<ReturnType<PredictiveFactor['evaluate']>>>,
  regime: string,
): string[] {
  const problems: string[] = [];
  const where = ` (${regime} regime)`;

  if (!['bullish', 'bearish', 'neutral'].includes(result.bias)) {
    problems.push(`evaluate() returned an invalid bias: ${result.bias}${where}`);
  }
  if (typeof result.weight !== 'number' || !Number.isFinite(result.weight) || result.weight < 0) {
    problems.push(`evaluate() returned a non-finite or negative weight: ${result.weight}${where}`);
  } else if (result.weight > MAX_GENERATED_WEIGHT) {
    problems.push(`evaluate() returned weight ${result.weight}, exceeding the ${MAX_GENERATED_WEIGHT} ceiling for generated factors.${where}`);
  }
  if (result.bucket !== 'MOMENTUM') {
    problems.push(`evaluate() result.bucket must be 'MOMENTUM', got '${result.bucket}'.${where}`);
  }
  if (!result.correlationGroup) {
    problems.push(`evaluate() result is missing correlationGroup.${where}`);
  }
  if (!result.reasoning || typeof result.reasoning !== 'string') {
    problems.push(`evaluate() result is missing a reasoning string.${where}`);
  }

  // buyTarget is a SUPPORT level, sellTarget is RESISTANCE. compositeScore.ts
  // bins each into supportLevels/resistanceLevels purely by comparing it to
  // spot, so a factor that emits them the wrong way round feeds its upside
  // target into the support cluster and its downside into resistance.
  //
  // Whether that reaches trade-plan levels depends on the gate at
  // compositeScore.ts:342 (PRICE_STRUCTURE bucket or a PRICE_LOCATION_FACTOR_NAMES
  // match). A MOMENTUM-bucketed generated factor is skipped there today, so this
  // is enforced as a contract invariant that must hold regardless of routing —
  // not because every violation is currently reachable.
  //
  // The shape checks above cannot catch this — it is a semantic inversion, not
  // a malformed field. AsymmetricKinematicEfficiencyFactor passed every other
  // gate and shipped live with buyTarget > sellTarget on its entire bullish
  // path (measured 3/8 symbols; every one of the 9 hand-written target-emitting
  // factors was 0/N).
  //
  // Checked as an ordering rather than "which side of spot": a band-based
  // factor legitimately has both bands below spot when price is extended above
  // them (Anchored VWAP does this), and that is not an inversion.
  const { buyTarget, sellTarget } = result;
  if (typeof buyTarget === 'number' && typeof sellTarget === 'number') {
    if (!Number.isFinite(buyTarget) || !Number.isFinite(sellTarget)) {
      problems.push(`evaluate() returned a non-finite target (buyTarget=${buyTarget}, sellTarget=${sellTarget}).${where}`);
    } else if (buyTarget > sellTarget) {
      problems.push(
        `evaluate() returned buyTarget (${buyTarget}) above sellTarget (${sellTarget}). ` +
        'buyTarget is the support/entry level and must never sit above the sellTarget ' +
        `resistance level — compositeScore bins them into support/resistance by price.${where}`,
      );
    }
  }

  return problems;
}

async function runAIQuant() {
  console.log('[AI Quant] 🤖 Waking up to generate a new market strategy...');
  
  if (!process.env.GEMINI_API_KEY) {
    console.error('[AI Quant] ❌ GEMINI_API_KEY is not set. Exiting.');
    process.exit(1);
  }

  const prompt = `
You are an elite quantitative developer at a high-frequency trading firm. 
Your task is to invent a novel, sophisticated trading factor and write the TypeScript code for it.
This factor will be integrated into the Hand of Midas engine.

Requirements for the file:
1. It MUST export a class that implements \`PredictiveFactor\` from \`./types.js\`.
2. It MUST evaluate \`FactorInput\` and return a \`Promise<FactorResult | null>\`.
3. Give the class a highly specific name (e.g., \`VolatilityDragFactor\`, \`OrderFlowImbalanceFactor\`).
4. Calculate some meaningful logic using the OHLCV \`bars\` or \`currentPrice\`.
5. The class MUST declare \`bucket = 'MOMENTUM' as const;\` and \`correlationGroup = 'AI_MICROSTRUCTURE';\` as class fields — this bucket is reserved for AI-generated factors so they are evidence-grouped together and never counted as independent votes alongside each other.
6. Every returned \`FactorResult\` object (including early-return/neutral cases) MUST include \`bucket: this.bucket\` and \`correlationGroup: this.correlationGroup\` — these are NOT inherited automatically from the class fields, they must be in the returned object literal.
7. \`weight\` MUST NEVER exceed 0.35 in any code path, under any input. Hand-tuned, reviewed factors top out at 0.35; a newly generated factor with no live track record must not be able to out-vote them. Clamp any computed weight with \`Math.min(0.35, ...)\`.
8. Return a valid \`FactorResult\` containing \`factorName\`, \`bias\`, \`weight\`, \`bucket\`, \`correlationGroup\`, and \`reasoning\`.

Example file structure:
\`\`\`typescript
import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class MyNovelFactor implements PredictiveFactor {
  name = 'My Novel Factor';
  bucket = 'MOMENTUM' as const;
  correlationGroup = 'AI_MICROSTRUCTURE';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    // your complex math here...
    return {
      factorName: this.name,
      bias: 'bullish',
      weight: Math.min(0.35, 0.15),
      bucket: this.bucket,
      correlationGroup: this.correlationGroup,
      reasoning: 'Detailed reasoning...',
      buyTarget: input.currentPrice * 0.98,
      sellTarget: input.currentPrice * 1.02
    };
  }
}
\`\`\`

Generate ONLY the markdown code block with the complete, valid TypeScript code. No other text.
`;

  let statsContext = '';
  try {
    const factorStatsItem = await getItem<FactorStatsItem>('SYSTEM', 'FACTOR_STATS');
    if (factorStatsItem && factorStatsItem.stats) {
      const stats = factorStatsItem.stats;
      statsContext = '\nHere is the historical performance of our active factors:\n';
      for (const [fname, st] of Object.entries(stats)) {
        if (st.tries > 0) {
          const accuracy = ((st.score / st.tries) * 100).toFixed(1);
          statsContext += `- ${fname}: ${accuracy}% accuracy (${st.wins} wins, ${st.losses} losses, ${st.tries} tries)\n`;
        }
      }
      statsContext += '\nPlease invent a novel factor that targets edges missed by the top performers and avoids the pitfalls of the worst performers.\n';
    }
  } catch (e) {
    console.warn('[AI Quant] Could not fetch FACTOR_STATS for context.');
  }

  const finalPrompt = prompt + statsContext;

  try {
    console.log('[AI Quant] 🧠 Hypothesizing edge via Gemini...');
    const text = await generateWithFallback(finalPrompt);

    // Extract TS code block
    const match = text.match(/```(?:typescript|ts)\n([\s\S]*?)```/);
    if (!match) {
      throw new Error('Failed to extract TypeScript code block from LLM response.');
    }
    
    const code = match[1];
    
    // Extract class name
    const classNameMatch = code.match(/export class ([a-zA-Z0-9_]+) implements PredictiveFactor/);
    if (!classNameMatch) {
      throw new Error('Could not find class name implementing PredictiveFactor in the generated code.');
    }
    
    const className = classNameMatch[1];
    const timestamp = Date.now();
    const filename = `ai_factor_${timestamp}.ts`;
    const filepath = path.join(FACTORS_DIR, filename);
    
    console.log(`[AI Quant] 💾 Writing generated factor to ${filename}...`);
    fs.writeFileSync(filepath, code);

    const rollback = (reason: string): never => {
      console.error(`[AI Quant] ❌ Rejecting generated factor: ${reason}`);
      fs.unlinkSync(filepath);
      throw new Error(reason);
    };

    // Gate 1: real type check. `npm run build`/`npm run dev` both transpile via
    // esbuild and never type-check, so a structurally invalid factor (e.g.
    // missing a required FactorResult field) would otherwise ship silently —
    // exactly how earlier generated factors ended up missing `bucket`.
    console.log('[AI Quant] 🧪 Type-checking generated factor...');
    try {
      execFileSync('npx', ['tsc', '--noEmit', '-p', '.'], { cwd: BACKEND_ROOT, encoding: 'utf-8', stdio: 'pipe' });
    } catch (tscErr: any) {
      const output: string = (tscErr.stdout || '') + (tscErr.stderr || '');
      if (output.includes(filename)) {
        rollback(`Generated file fails type-check:\n${output}`);
      }
      // Otherwise the failures are pre-existing elsewhere in the repo — not this factor's fault, proceed.
      console.warn('[AI Quant] ⚠️ tsc reported pre-existing errors unrelated to the generated file; continuing.');
    }

    // Gate 2: instantiate and run against synthetic data, checking the same
    // bounds the rest of the engine relies on (bias/weight/bucket/correlationGroup).
    console.log('[AI Quant] 🧪 Running behavioral smoke test on synthetic data...');
    const module = await import(filepath);
    const instance = new module[className]();
    if (!instance.name || typeof instance.evaluate !== 'function') {
      rollback('Instantiated class does not conform to PredictiveFactor interface.');
    }

    const problems = await validateGeneratedFactor(instance);
    if (problems.length > 0) {
      rollback(`Generated factor failed validation:\n- ${problems.join('\n- ')}`);
    }

    console.log(`[AI Quant] ✅ Validation passed. Injecting ${className} into the factor registry...`);

    let registryData = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    
    // Inject import
    const importStr = `import { ${className} } from './ai_factor_${timestamp}.js';\n// [AI_QUANT_IMPORTS_END]`;
    registryData = registryData.replace('// [AI_QUANT_IMPORTS_END]', importStr);
    
    // Inject instance
    const instanceStr = `new ${className}(),\n    // [AI_QUANT_FACTOR_INSTANCES_END]`;
    registryData = registryData.replace('// [AI_QUANT_FACTOR_INSTANCES_END]', instanceStr);
    
    fs.writeFileSync(REGISTRY_PATH, registryData);
    
    console.log(`[AI Quant] 🎉 Success! The engine is now running with ${className}.`);
    
  } catch (error) {
    console.error('[AI Quant] ❌ Execution failed:', error);
    process.exit(1);
  }
}

runAIQuant();
