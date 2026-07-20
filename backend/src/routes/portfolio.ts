import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { queryItems, putItem, deleteItem } from '../services/dynamodb.js';
import { blackScholes, impliedVolatility } from '../services/greeks.js';
import { getQuote } from '../services/polygon.js';
import crypto from 'crypto';

interface PositionLeg {
  ticker: string;
  quantity: number;
  costBasis: number;
  currentPrice?: number;
  optionDetails?: {
    strike: number;
    expiry: string;
    type: 'call' | 'put';
    multiplier: number;
  };
}

interface Position {
  pk: string;
  sk: string;
  id: string;
  userId: string;
  symbol: string;
  type: 'stock' | 'option';
  strategy: string;
  legs: PositionLeg[];
  openDate: string;
  closeDate?: string;
  status: 'open' | 'closed';
  notes?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

function getUserId(event: APIGatewayProxyEventV2): string | null {
  return event.requestContext?.authorizer?.jwt?.claims['sub'] ?? null;
}

function positionPK(userId: string): string {
  return `USER#${userId}`;
}

function positionSK(positionId: string): string {
  return `POSITION#${positionId}`;
}

export async function getPositions(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) return jsonResponse(401, { error: 'Unauthorized' });

  try {
    const items = await queryItems<Position>(positionPK(userId), 'POSITION#');
    return jsonResponse(200, { positions: items });
  } catch (err: any) {
    return jsonResponse(500, { error: err.message });
  }
}

export async function addPosition(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) return jsonResponse(401, { error: 'Unauthorized' });

  if (!event.body) {
    return jsonResponse(400, { error: 'Request body is required' });
  }

  try {
    let bodyText = event.body;
    if (event.isBase64Encoded) {
      bodyText = Buffer.from(bodyText, 'base64').toString('utf-8');
    }
    
    const parsed = JSON.parse(bodyText);
    const positionId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    const newPosition: Position = {
      ...parsed,
      pk: positionPK(userId),
      sk: positionSK(positionId),
      id: positionId,
      userId,
      createdAt: now,
      updatedAt: now,
    };
    
    await putItem(newPosition);
    return jsonResponse(201, newPosition);
  } catch (err: any) {
    return jsonResponse(400, { error: err.message });
  }
}

export async function updatePosition(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) return jsonResponse(401, { error: 'Unauthorized' });

  const positionId = params['id'];
  if (!positionId) return jsonResponse(400, { error: '"id" is required' });

  if (!event.body) {
    return jsonResponse(400, { error: 'Request body is required' });
  }

  try {
    let bodyText = event.body;
    if (event.isBase64Encoded) {
      bodyText = Buffer.from(bodyText, 'base64').toString('utf-8');
    }
    
    const parsed = JSON.parse(bodyText);
    const now = new Date().toISOString();
    
    const updatedPosition: Position = {
      ...parsed,
      pk: positionPK(userId),
      sk: positionSK(positionId),
      id: positionId,
      userId,
      updatedAt: now,
    };
    
    await putItem(updatedPosition);
    return jsonResponse(200, updatedPosition);
  } catch (err: any) {
    return jsonResponse(400, { error: err.message });
  }
}

export async function deletePosition(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) return jsonResponse(401, { error: 'Unauthorized' });

  const positionId = params['id'];
  if (!positionId) return jsonResponse(400, { error: '"id" is required' });

  try {
    await deleteItem(positionPK(userId), positionSK(positionId));
    return jsonResponse(204, undefined);
  } catch (err: any) {
    return jsonResponse(500, { error: err.message });
  }
}

export async function getPortfolioSummary(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) return jsonResponse(401, { error: 'Unauthorized' });

  try {
    const items = await queryItems<Position>(positionPK(userId), 'POSITION#');
    const openPositions = items.filter(pos => pos.status === 'open');

    const symbols = Array.from(new Set(openPositions.map(p => p.symbol)));
    const quoteMap: Record<string, number> = {};
    await Promise.all(
      symbols.map(async sym => {
        try {
          const q = await getQuote(sym);
          quoteMap[sym] = q.price;
        } catch {
          quoteMap[sym] = 0;
        }
      }),
    );

    let netDelta = 0;
    let netGamma = 0;
    let netThetaPerDay = 0;
    let netVega = 0;
    let totalValue = 0;
    let totalCost = 0;

    const positionsWithGreeks = openPositions.map(pos => {
      const S = quoteMap[pos.symbol] ?? 0;
      let posDelta = 0, posGamma = 0, posTheta = 0, posVega = 0;
      let posValue = 0, posCost = 0;

      for (const leg of pos.legs) {
        const qty = leg.quantity;

        if (!leg.optionDetails) {
          // Stock leg: delta normalised to option-contract scale (1 share = 1 delta unit × 100)
          posDelta += qty * 100;
          const price = leg.currentPrice ?? leg.costBasis;
          posValue += price * qty;
          posCost += leg.costBasis * qty;
        } else {
          const { strike, expiry, type, multiplier } = leg.optionDetails;
          const daysToExpiry = Math.max(0, (new Date(expiry).getTime() - Date.now()) / 86400000);
          const T = Math.max(0.0027, daysToExpiry / 365);
          const r = 0.05;

          let sigma = 0.3;
          if (S > 0) {
            const optionPrice = leg.currentPrice ?? leg.costBasis;
            const computedIV = impliedVolatility(optionPrice, S, strike, T, r, type);
            if (computedIV !== null && computedIV > 0.01) sigma = computedIV;
          }

          const g = S > 0
            ? blackScholes(S, strike, T, r, sigma, type)
            : { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, price: 0 };

          posDelta += g.delta * qty * multiplier;
          posGamma += g.gamma * qty * multiplier;
          posTheta += g.theta * qty * multiplier;
          posVega += g.vega * qty * multiplier;

          const currentOptionPrice = leg.currentPrice ?? leg.costBasis;
          posValue += currentOptionPrice * qty * multiplier;
          posCost += leg.costBasis * qty * multiplier;
        }
      }

      netDelta += posDelta;
      netGamma += posGamma;
      netThetaPerDay += posTheta;
      netVega += posVega;
      totalValue += posValue;
      totalCost += posCost;

      return {
        ...pos,
        currentValue: posValue,
        unrealizedPnL: posValue - posCost,
        delta: posDelta,
        theta: posTheta,
        vega: posVega,
      };
    });

    const unrealizedPnL = totalValue - totalCost;
    const unrealizedPnLPercent = totalCost !== 0 ? (unrealizedPnL / totalCost) * 100 : 0;

    return jsonResponse(200, {
      totalValue,
      totalCost,
      unrealizedPnL,
      unrealizedPnLPercent,
      netDelta,
      netGamma,
      netThetaPerDay,
      netVega,
      positions: positionsWithGreeks,
    });
  } catch (err: any) {
    return jsonResponse(500, { error: err.message });
  }
}

export async function runScenario(
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const userId = getUserId(event);
  if (!userId) return jsonResponse(401, { error: 'Unauthorized' });

  if (!event.body) {
    return jsonResponse(400, { error: 'Request body is required' });
  }

  try {
    let bodyText = event.body;
    if (event.isBase64Encoded) {
      bodyText = Buffer.from(bodyText, 'base64').toString('utf-8');
    }

    const { deltaSpot, deltaIV } = JSON.parse(bodyText) as { deltaSpot: number; deltaIV: number };

    const items = await queryItems<Position>(positionPK(userId), 'POSITION#');
    const openPositions = items.filter(pos => pos.status === 'open');

    const symbols = Array.from(new Set(openPositions.map(p => p.symbol)));
    const quoteMap: Record<string, number> = {};
    await Promise.all(
      symbols.map(async sym => {
        try {
          const q = await getQuote(sym);
          quoteMap[sym] = q.price;
        } catch {
          quoteMap[sym] = 0;
        }
      }),
    );

    let scenarioPL = 0;
    for (const pos of openPositions) {
      const S = quoteMap[pos.symbol] ?? 0;

      for (const leg of pos.legs) {
        const qty = leg.quantity;
        let legDelta = 0, legGamma = 0, legVega = 0;

        if (!leg.optionDetails) {
          legDelta = qty * 100;
        } else {
          const { strike, expiry, type, multiplier } = leg.optionDetails;
          const daysToExpiry = Math.max(0, (new Date(expiry).getTime() - Date.now()) / 86400000);
          const T = Math.max(0.0027, daysToExpiry / 365);
          const r = 0.05;

          let sigma = 0.3;
          if (S > 0) {
            const optionPrice = leg.currentPrice ?? leg.costBasis;
            const computedIV = impliedVolatility(optionPrice, S, strike, T, r, type);
            if (computedIV !== null && computedIV > 0.01) sigma = computedIV;
          }

          const g = S > 0
            ? blackScholes(S, strike, T, r, sigma, type)
            : { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, price: 0 };

          legDelta = g.delta * qty * multiplier;
          legGamma = g.gamma * qty * multiplier;
          legVega = g.vega * qty * multiplier;
        }

        // dP/L ≈ delta·ΔS + 0.5·gamma·ΔS² + vega·ΔIV - theta (theta omitted for scenario)
        scenarioPL +=
          legDelta * deltaSpot +
          0.5 * legGamma * deltaSpot * deltaSpot +
          legVega * deltaIV;
      }
    }

    return jsonResponse(200, { scenarioPL });
  } catch (err: any) {
    return jsonResponse(400, { error: err.message });
  }
}
