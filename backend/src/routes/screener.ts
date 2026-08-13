import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { runScreener, ScreenerMode } from '../services/screenerService.js';
import { getCachedData, setCachedData } from '../services/cache.js';

export async function getScreener(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const modeStr = event.queryStringParameters?.mode;
    const mode: ScreenerMode =
      modeStr === 'premarket' ? 'premarket' :
      modeStr === 'momentum'  ? 'momentum'  :
      modeStr === 'highdemand'? 'highdemand' : 'open';

    const cacheKey = `SCREENER#${mode.toUpperCase()}`;
    const cached = await getCachedData(cacheKey);

    if (cached) {
      console.log(`[Screener API] Serving ${mode} from cache.`);
      return jsonResponse(200, cached, { 'Cache-Control': 'public, max-age=15' });
    }

    console.log(`[Screener API] Cache miss for ${mode}. Running full scan...`);
    const results = await runScreener(mode);
    await setCachedData(cacheKey, results, 15);
    
    return jsonResponse(200, results, { 'Cache-Control': 'public, max-age=15' });
  } catch (error: any) {
    console.error('Error running screener:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}
