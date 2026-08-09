import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { runScreener, ScreenerMode } from '../services/screenerService.js';

export async function getScreener(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const modeStr = event.queryStringParameters?.mode;
    const mode: ScreenerMode =
      modeStr === 'premarket' ? 'premarket' :
      modeStr === 'momentum'  ? 'momentum'  :
      modeStr === 'highdemand'? 'highdemand' : 'open';

    const results = await runScreener(mode);
    return jsonResponse(200, results);
  } catch (error: any) {
    console.error('Error running screener:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}
