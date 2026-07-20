import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from '../types.js';
import { jsonResponse } from '../utils/response.js';
import { queryItems, putItem, deleteItem } from '../services/dynamodb.js';
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
    
    let netUnrealizedPL = 0;
    let netDelta = 0;
    let netTheta = 0;
    let netVega = 0;
    
    for (const pos of items) {
      // Mocked calculation
      // Here you would compute Greek summaries per position
      if (pos.status === 'open') {
         // netUnrealizedPL += ...
      }
    }

    return jsonResponse(200, {
      netUnrealizedPL,
      netDelta,
      netTheta,
      netVega,
      positionCount: items.length
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
    
    const { deltaSpot, deltaIV } = JSON.parse(bodyText) as { deltaSpot: number, deltaIV: number };
    
    const items = await queryItems<Position>(positionPK(userId), 'POSITION#');
    
    let scenarioPL = 0;
    for (const pos of items) {
      if (pos.status === 'open') {
         // dP/L ≈ delta*deltaSpot + 0.5*gamma*deltaSpot^2 + vega*deltaIV
         // Mock Greek values for legs
         const posDelta = 0; 
         const posGamma = 0;
         const posVega = 0;
         const pl = (posDelta * deltaSpot) + (0.5 * posGamma * Math.pow(deltaSpot, 2)) + (posVega * deltaIV);
         scenarioPL += pl;
      }
    }
    
    return jsonResponse(200, { scenarioPL });
  } catch (err: any) {
    return jsonResponse(400, { error: err.message });
  }
}
