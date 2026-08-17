import 'dotenv/config';
import { getPredictiveZones } from '../services/predictiveEngine.js';

async function main() {
  console.log('Fetching AI Trade Plan for WULF...');
  try {
    const result = await getPredictiveZones('WULF');
    console.log('\n================ AI COMMITTEE SYNTHESIS ================');
    console.log(result.aiThesis.summary);
    console.log('========================================================\n');
  } catch (err) {
    console.error('Test Failed:', err);
  }
}

main();
