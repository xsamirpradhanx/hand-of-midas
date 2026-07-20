import type { APIGatewayProxyResultV2 } from '../types.js';

// ---------------------------------------------------------------------------
// CORS headers — applied to EVERY response.
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Build a JSON API Gateway response with CORS headers.
 *
 * @param statusCode - HTTP status code.
 * @param body       - Response payload (will be JSON-stringified). Pass
 *                     `undefined` for no-content responses (e.g. 204).
 * @returns A fully-formed {@link APIGatewayProxyResultV2}.
 */
export function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

/** Re-export the raw CORS headers for the OPTIONS handler in index.ts. */
export { CORS_HEADERS };
