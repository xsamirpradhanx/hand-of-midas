import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { getOptionsMetrics } from './optionsMetrics.js';
import { generateInsight, MarketMetrics } from '../services/aiInsights.js';

function jsonResponse(statusCode: number, body: any): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

export async function getOptionsInsights(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  // We reuse the existing metrics route to compute all the data
  const metricsResult = await getOptionsMetrics(event, params);
  
  if (metricsResult.statusCode !== 200) {
    return metricsResult;
  }

  try {
    const data = JSON.parse(metricsResult.body as string);
    const metrics: MarketMetrics = {
      symbol: data.symbol,
      expiry: data.maxPainExpiry,
      spotPrice: data.spotPrice,
      maxPainStrike: data.maxPainStrike,
      volumeSkew: data.putCallSkew.volumeRatio,
      oiSkew: data.putCallSkew.oiRatio,
      gexProfile: data.gexProfile,
    };

    const insightText = await generateInsight(metrics);

    return jsonResponse(200, { insight: insightText });
  } catch (err: any) {
    console.error('Failed to generate insight:', err);
    return jsonResponse(500, { error: 'Failed to generate insight' });
  }
}
