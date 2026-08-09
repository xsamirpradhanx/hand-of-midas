import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { runDiagonalScreener } from '../services/diagonalScreenerService.js';

export async function getDiagonalScreener(
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const results = await runDiagonalScreener();
    return jsonResponse(200, results);
  } catch (error: any) {
    console.error('[DiagonalScreenerRoute] Error:', error);
    return jsonResponse(500, { error: error.message || 'Internal Server Error' });
  }
}
