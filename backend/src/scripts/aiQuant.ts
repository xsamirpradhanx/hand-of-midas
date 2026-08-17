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
 * Builds a plausible-looking synthetic OHLCV series so a freshly generated
 * factor's evaluate() can be smoke-tested without hitting a real data
 * provider. Deterministic (no Math.random) so failures are reproducible.
 */
function buildSyntheticBars(length: number): FactorInput['bars'] {
  const bars: FactorInput['bars'] = [];
  let price = 100;
  for (let i = 0; i < length; i++) {
    // Deterministic pseudo-oscillation so entropy/efficiency-style factors
    // see non-degenerate (non-flat, non-monotonic) input.
    const drift = Math.sin(i / 7) * 1.5 + Math.cos(i / 3) * 0.5;
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

  const bars = buildSyntheticBars(60);
  const sampleInput: FactorInput = { symbol: 'TEST', currentPrice: bars[bars.length - 1].close, bars };

  let result;
  try {
    result = await instance.evaluate(sampleInput);
  } catch (err) {
    problems.push(`evaluate() threw on synthetic input: ${err instanceof Error ? err.message : String(err)}`);
    return problems;
  }

  if (result === null) {
    // A factor that abstains on synthetic data is acceptable — real market
    // data may still trigger it. Nothing further to check.
    return problems;
  }

  if (!['bullish', 'bearish', 'neutral'].includes(result.bias)) {
    problems.push(`evaluate() returned an invalid bias: ${result.bias}`);
  }
  if (typeof result.weight !== 'number' || !Number.isFinite(result.weight) || result.weight < 0) {
    problems.push(`evaluate() returned a non-finite or negative weight: ${result.weight}`);
  } else if (result.weight > MAX_GENERATED_WEIGHT) {
    problems.push(`evaluate() returned weight ${result.weight}, exceeding the ${MAX_GENERATED_WEIGHT} ceiling for generated factors.`);
  }
  if (result.bucket !== 'MOMENTUM') {
    problems.push(`evaluate() result.bucket must be 'MOMENTUM', got '${result.bucket}'.`);
  }
  if (!result.correlationGroup) {
    problems.push('evaluate() result is missing correlationGroup.');
  }
  if (!result.reasoning || typeof result.reasoning !== 'string') {
    problems.push('evaluate() result is missing a reasoning string.');
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
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: finalPrompt,
    });

    const text = response.text || '';
    
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
