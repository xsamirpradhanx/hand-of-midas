import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { getItem, queryItems, putItem, deleteItem } from '../services/dynamodb.js';
import { blackScholes, impliedVolatility , getRiskFreeRate } from '../services/greeks.js';
import { getQuote } from '../services/polygon.js';
import { getTimeToExpiryYears } from '../services/tradingCalendar.js';
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
  version: number;
}

function isValidPositionInput(value: unknown): value is Omit<Position, 'pk' | 'sk' | 'id' | 'userId' | 'createdAt' | 'updatedAt'> {
  if (!value || typeof value !== 'object') return false;
  const position = value as Partial<Position>;
  return typeof position.symbol === 'string' && /^[A-Za-z.\-]{1,16}$/.test(position.symbol)
    && (position.type === 'stock' || position.type === 'option')
    && Array.isArray(position.legs) && position.legs.length > 0
    && position.legs.every(leg => typeof leg?.ticker === 'string'
      && Number.isFinite(leg.quantity) && leg.quantity !== 0
      && Number.isFinite(leg.costBasis) && leg.costBasis >= 0
      && (!leg.optionDetails || (Number.isFinite(leg.optionDetails.strike) && leg.optionDetails.strike > 0
        && /^\d{4}-\d{2}-\d{2}$/.test(leg.optionDetails.expiry)
        && (leg.optionDetails.type === 'call' || leg.optionDetails.type === 'put')
        && Number.isFinite(leg.optionDetails.multiplier) && leg.optionDetails.multiplier > 0)));
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
    if (!isValidPositionInput(parsed)) {
      return jsonResponse(400, { error: 'Invalid position payload' });
    }
    const positionId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    const newPosition: Position = {
      ...parsed,
      symbol: parsed.symbol.toUpperCase(),
      pk: positionPK(userId),
      sk: positionSK(positionId),
      id: positionId,
      userId,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    
    await putItem(newPosition, 0);
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
    if (!isValidPositionInput(parsed)) {
      return jsonResponse(400, { error: 'Invalid position payload' });
    }
    const now = new Date().toISOString();
    const existing = await getItem<Position>(positionPK(userId), positionSK(positionId));
    if (!existing) return jsonResponse(404, { error: 'Position not found' });
    
    const updatedPosition: Position = {
      ...parsed,
      symbol: parsed.symbol.toUpperCase(),
      pk: positionPK(userId),
      sk: positionSK(positionId),
      id: positionId,
      userId,
      createdAt: existing.createdAt,
      updatedAt: now,
      version: (existing.version || 1) + 1,
    };
    
    await putItem(updatedPosition, existing.version || 1);
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
          // Delta is expressed in underlying share equivalents. Do not apply an
          // option multiplier to stock quantities.
          posDelta += qty;
          const price = S > 0 ? S : (leg.currentPrice ?? leg.costBasis);
          posValue += price * qty;
          posCost += leg.costBasis * qty;
        } else {
          const { strike, expiry, type, multiplier } = leg.optionDetails;
          const T = Math.max(1 / 365, getTimeToExpiryYears(expiry));
          const r = getRiskFreeRate();

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

          // Hierarchy: leg.currentPrice (live) -> g.price (model) -> leg.costBasis (stale fallback)
          const currentOptionPrice = leg.currentPrice ?? (S > 0 && g.price > 0 ? g.price : leg.costBasis);
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
          legDelta = qty;
        } else {
          const { strike, expiry, type, multiplier } = leg.optionDetails;
          const T = Math.max(1 / 365, getTimeToExpiryYears(expiry));
          const r = getRiskFreeRate();

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
