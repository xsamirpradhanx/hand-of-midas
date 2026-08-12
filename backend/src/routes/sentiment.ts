import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getAggregatedSentiment } from '../services/sentimentAggregator.js';

export async function getSentiment(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  try {
    const symbol = params['symbol'];
    if (!symbol) {
      return jsonResponse(400, { error: 'Symbol is required' });
    }

    const data = await getAggregatedSentiment(symbol);
    return jsonResponse(200, data);
  } catch (err: any) {
    console.error(`Failed to get sentiment for ${params['symbol']}:`, err);
    return jsonResponse(500, { error: 'Failed to get sentiment data' });
  }
}
