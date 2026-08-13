import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FACTORS_DIR = path.join(__dirname, '../services/factors');
const REGISTRY_PATH = path.join(FACTORS_DIR, 'factorRegistry.ts');

import { getItem } from '../services/dynamodb.js';
import type { FactorStatsItem } from '../types.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
5. Return a valid \`FactorResult\` containing \`factorName\`, \`bias\`, \`weight\`, and \`reasoning\`.

Example file structure:
\`\`\`typescript
import type { PredictiveFactor, FactorInput, FactorResult } from './types.js';

export class MyNovelFactor implements PredictiveFactor {
  name = 'My Novel Factor';

  async evaluate(input: FactorInput): Promise<FactorResult | null> {
    // your complex math here...
    return {
      factorName: this.name,
      bias: 'bullish',
      weight: 0.15,
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
    
    // Smoke test: Can we dynamically import it?
    console.log(`[AI Quant] 🧪 Running smoke test compilation via dynamic import...`);
    const module = await import(filepath);
    const instance = new module[className]();
    if (!instance.name || typeof instance.evaluate !== 'function') {
        throw new Error('Instantiated class does not conform to PredictiveFactor interface.');
    }
    
    console.log(`[AI Quant] ✅ Smoke test passed. Injecting ${className} into the factor registry...`);
    
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
