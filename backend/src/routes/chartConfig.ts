import { getItem, putItem } from '../services/dynamodb.js';
import type {
  ChartConfigItem,
  ChartConfigPayload,
  ChartConfigResponse,
  IndicatorConfig,
  APIGatewayProxyResultV2,
} from '../types.js';
import { jsonResponse } from '../index.js';

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function userPK(userId: string): string {
  return `USER#${userId}`;
}

function configSK(symbol: string): string {
  return `CONFIG#${symbol.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed body conforms to {@link ChartConfigPayload}.
 * Returns a human-readable error string on failure, or `null` on success.
 */
function validatePayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'Request body must be a JSON object';
  }

  const obj = payload as Record<string, unknown>;

  if (!Array.isArray(obj['indicators'])) {
    return '"indicators" must be an array';
  }

  for (let i = 0; i < obj['indicators'].length; i++) {
    const ind = obj['indicators'][i] as Record<string, unknown>;
    if (typeof ind !== 'object' || ind === null) {
      return `indicators[${i}] must be an object`;
    }
    if (typeof ind['type'] !== 'string' || ind['type'].length === 0) {
      return `indicators[${i}].type must be a non-empty string`;
    }
    if (typeof ind['enabled'] !== 'boolean') {
      return `indicators[${i}].enabled must be a boolean`;
    }
    if (typeof ind['params'] !== 'object' || ind['params'] === null || Array.isArray(ind['params'])) {
      return `indicators[${i}].params must be a plain object`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/chart-config/:symbol
 *
 * Retrieve the saved chart indicator configuration for a given symbol
 * and authenticated user.
 *
 * @param userId - The authenticated user's subject claim.
 * @param symbol - Ticker symbol extracted from the URL path.
 * @returns A JSON response with the chart config, or 404 if none exists.
 */
export async function getChartConfig(
  userId: string,
  symbol: string,
): Promise<APIGatewayProxyResultV2> {
  const upperSymbol = symbol.trim().toUpperCase();
  if (!upperSymbol) {
    return jsonResponse(400, { error: '"symbol" path parameter is required' });
  }

  const item = await getItem<ChartConfigItem>(userPK(userId), configSK(upperSymbol));

  if (!item) {
    return jsonResponse(404, {
      error: `No chart configuration found for symbol "${upperSymbol}".`,
    });
  }

  const body: ChartConfigResponse = {
    symbol: upperSymbol,
    indicators: item.indicators,
    updatedAt: item.updatedAt,
  };

  return jsonResponse(200, body);
}

/**
 * PUT /api/chart-config/:symbol
 *
 * Create or overwrite the chart indicator configuration for a given
 * symbol and authenticated user.
 *
 * Expects a JSON body: `{ "indicators": [ ... ] }`.
 *
 * @param userId - The authenticated user's subject claim.
 * @param symbol - Ticker symbol extracted from the URL path.
 * @param body   - Raw request body string.
 * @returns A 200 response with the saved config, or 400 on bad input.
 */
export async function saveChartConfig(
  userId: string,
  symbol: string,
  body: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  const upperSymbol = symbol.trim().toUpperCase();
  if (!upperSymbol) {
    return jsonResponse(400, { error: '"symbol" path parameter is required' });
  }

  if (!body) {
    return jsonResponse(400, { error: 'Request body is required' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON in request body' });
  }

  const validationError = validatePayload(parsed);
  if (validationError) {
    return jsonResponse(400, { error: validationError });
  }

  const payload = parsed as ChartConfigPayload;
  const now = new Date().toISOString();

  const item: ChartConfigItem = {
    pk: userPK(userId),
    sk: configSK(upperSymbol),
    indicators: payload.indicators as IndicatorConfig[],
    updatedAt: now,
  };

  await putItem(item);

  const responseBody: ChartConfigResponse = {
    symbol: upperSymbol,
    indicators: item.indicators,
    updatedAt: now,
  };

  return jsonResponse(200, responseBody);
}
