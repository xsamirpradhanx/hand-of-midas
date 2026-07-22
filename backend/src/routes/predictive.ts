import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getPredictiveZones } from '../services/predictiveEngine.js';
import { getCachedData, setCachedData } from '../services/cache.js';

export async function getPredictionZonesRoute(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const symbol = params['symbol']?.toUpperCase();
  if (!symbol) {
    return jsonResponse(400, { error: '"symbol" is required' });
  }

  const forceRefresh = event.queryStringParameters?.refresh === 'true';
  const cacheKey = `PREDICTIVE_ZONES#${symbol}`;
  
  if (!forceRefresh) {
    const cached = await getCachedData<any>(cacheKey);
    if (cached) {
      return jsonResponse(200, cached);
    }
  }

  try {
    const data = await getPredictiveZones(symbol);
    
    // Cache for 1 hour to prevent excessive API calls to Polygon (news & OHLCV)
    await setCachedData(cacheKey, data, 3600);
    
    return jsonResponse(200, data);
  } catch (err: any) {
    console.error('Predictive Engine Error:', err);
    return jsonResponse(500, { error: err.message });
  }
}
