import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from './types.js';
import { jsonResponse, CORS_HEADERS } from './utils/response.js';
import * as watchlist from './routes/watchlist.js';
import * as marketdata from './routes/marketdata.js';
import * as quote from './routes/quote.js';
import * as chartConfig from './routes/chartConfig.js';
import * as optionsMetrics from './routes/optionsMetrics.js';

// Re-export so it's available from the package root for convenience.
export { jsonResponse } from './utils/response.js';

import * as options from './routes/options.js';
import * as portfolio from './routes/portfolio.js';
import * as insights from './routes/insights.js';
import * as alerts from './routes/alerts.js';

// ---------------------------------------------------------------------------
// Path-matching helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to match a request path against a pattern that may contain
 * `:param` segments.
 *
 * @example
 * matchPath('/api/watchlist/AAPL', '/api/watchlist/:symbol')
 * // => { symbol: 'AAPL' }
 *
 * matchPath('/api/watchlist', '/api/watchlist')
 * // => {}
 *
 * matchPath('/api/other', '/api/watchlist')
 * // => null
 */
function matchPath(
  requestPath: string,
  pattern: string,
): Record<string, string> | null {
  const reqParts = requestPath.replace(/\/+$/, '').split('/');
  const patParts = pattern.replace(/\/+$/, '').split('/');

  if (reqParts.length !== patParts.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patParts.length; i++) {
    const pat = patParts[i]!;
    const req = reqParts[i]!;

    if (pat.startsWith(':')) {
      params[pat.slice(1)] = decodeURIComponent(req);
    } else if (pat !== req) {
      return null;
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

interface Route {
  readonly method: string;
  readonly pattern: string;
  readonly handler: (
    event: APIGatewayProxyEventV2,
    params: Record<string, string>,
  ) => Promise<APIGatewayProxyResultV2>;
}

/**
 * Extract the authenticated user ID from the JWT authorizer claims.
 * Returns `null` if the claim is missing.
 */
function getUserId(event: APIGatewayProxyEventV2): string | null {
  return event.requestContext.authorizer?.jwt?.claims['sub'] ?? null;
}

const routes: readonly Route[] = [
  // ── Watchlist ──────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/api/watchlist',
    handler: async (event) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      return watchlist.getWatchlist(userId);
    },
  },
  {
    method: 'POST',
    pattern: '/api/watchlist',
    handler: async (event) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      
      let body = event.body;
      if (body && event.isBase64Encoded) {
        body = Buffer.from(body, 'base64').toString('utf-8');
      }
      
      return watchlist.addToWatchlist(userId, body);
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/watchlist/:symbol',
    handler: async (event, params) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      return watchlist.removeFromWatchlist(userId, params['symbol']!);
    },
  },

  // ── Market Data ────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/api/market-data/:symbol',
    handler: async (event, params) => {
      return marketdata.getMarketData(
        params['symbol']!,
        event.queryStringParameters,
      );
    },
  },

  // ── Quote ──────────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/api/quote/:symbol',
    handler: async (_event, params) => {
      return quote.getQuote(params['symbol']!);
    },
  },

  // ── Chart Config ───────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/api/chart-config/:symbol',
    handler: async (event, params) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      return chartConfig.getChartConfig(userId, params['symbol']!);
    },
  },
  {
    method: 'PUT',
    pattern: '/api/chart-config/:symbol',
    handler: async (event, params) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      
      let body = event.body;
      if (body && event.isBase64Encoded) {
        body = Buffer.from(body, 'base64').toString('utf-8');
      }

      return chartConfig.saveChartConfig(
        userId,
        params['symbol']!,
        body,
      );
    },
  },

  // ── Options ────────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/api/options/chain/:symbol',
    handler: async (event, params) => {
      return options.getOptionsChain(event, params);
    },
  },
  {
    method: 'GET',
    pattern: '/api/options/unusual',
    handler: async (event, params) => {
      return options.getUnusualActivityFeed(event, params);
    },
  },
  {
    method: 'GET',
    pattern: '/api/options/metrics/:symbol',
    handler: async (event, params) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      return optionsMetrics.getOptionsMetrics(event, params);
    },
  },
  {
    method: 'GET',
    pattern: '/api/options/insights/:symbol',
    handler: async (event, params) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      return insights.getOptionsInsights(event, params);
    },
  },
  {
    method: 'GET',
    pattern: '/api/alerts',
    handler: async (event, params) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      return alerts.getAlerts(event);
    },
  },
  {
    method: 'POST',
    pattern: '/api/alerts',
    handler: async (event, params) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      return alerts.createAlert(event);
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/alerts/:id',
    handler: async (event, params) => {
      const userId = getUserId(event);
      if (!userId) return jsonResponse(401, { error: 'Unauthorized' });
      return alerts.deleteAlert(event, params);
    },
  },
  {
    method: 'GET',
    pattern: '/api/options/ivhistory/:symbol',
    handler: async (event, params) => {
      return options.getIVHistory(event, params);
    },
  },

  // ── Portfolio ──────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/api/portfolio/positions',
    handler: async (event, params) => {
      return portfolio.getPositions(event, params);
    },
  },
  {
    method: 'POST',
    pattern: '/api/portfolio/positions',
    handler: async (event, params) => {
      return portfolio.addPosition(event, params);
    },
  },
  {
    method: 'PUT',
    pattern: '/api/portfolio/positions/:id',
    handler: async (event, params) => {
      return portfolio.updatePosition(event, params);
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/portfolio/positions/:id',
    handler: async (event, params) => {
      return portfolio.deletePosition(event, params);
    },
  },
  {
    method: 'GET',
    pattern: '/api/portfolio/summary',
    handler: async (event, params) => {
      return portfolio.getPortfolioSummary(event, params);
    },
  },
  {
    method: 'POST',
    pattern: '/api/portfolio/scenario',
    handler: async (event, params) => {
      return portfolio.runScenario(event, params);
    },
  },
];

// ---------------------------------------------------------------------------

// Lambda handler
// ---------------------------------------------------------------------------

/**
 * Single Lambda entry-point that dispatches to the correct route handler
 * based on the HTTP method and path from the API Gateway v2 event.
 *
 * @param event - The API Gateway v2 proxy integration event.
 * @returns The proxy integration response.
 */
export async function handler(
  event: APIGatewayProxyEventV2 | { source: string; action: string },
): Promise<APIGatewayProxyResultV2 | void> {
  // Handle scheduled cache refresh from EventBridge
  if ('source' in event && event.source === 'scheduled') {
    console.log('Running scheduled cache refresh...');
    // Add logic here to refresh cache if needed in the future
    return;
  }

  const apiEvent = event as APIGatewayProxyEventV2;
  const method = apiEvent.requestContext.http.method.toUpperCase();
  const path = apiEvent.requestContext.http.path;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: undefined,
    };
  }

  try {
    // Find the first matching route
    for (const route of routes) {
      if (route.method !== method) continue;

      const params = matchPath(path, route.pattern);
      if (params !== null) {
        return await route.handler(apiEvent, params);
      }
    }

    // No route matched
    return jsonResponse(404, {
      error: `No route matched: ${method} ${path}`,
    });
  } catch (error: unknown) {
    console.error('Unhandled error in Lambda handler:', error);

    const message =
      error instanceof Error ? error.message : 'Internal Server Error';

    return jsonResponse(500, { error: message });
  }
}
