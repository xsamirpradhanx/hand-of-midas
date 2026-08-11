// backend/src/services/factors/optionsFlowInference.ts

/**
 * Infers the direction and intent of options flow based on execution relative to NBBO.
 */

export type TradeInference =
  | 'Opening Long Call'
  | 'Opening Long Put'
  | 'Covered Call'
  | 'Cash-Secured Put'
  | 'Call Spread'
  | 'Put Spread'
  | 'Roll'
  | 'Closing Position'
  | 'Unknown';

export interface OptionsTradeContext {
  type: 'call' | 'put';
  executionPrice: number;
  bid: number;
  ask: number;
  volume: number;
  openInterest: number;
  isSweep: boolean;
}

export function inferTradeDirection(trade: OptionsTradeContext): 'bought' | 'sold' | 'midpoint' {
  const midpoint = (trade.bid + trade.ask) / 2;
  
  if (trade.executionPrice >= trade.ask) {
    return 'bought';
  } else if (trade.executionPrice <= trade.bid) {
    return 'sold';
  } else if (trade.executionPrice > midpoint) {
    return 'bought'; // closer to ask
  } else if (trade.executionPrice < midpoint) {
    return 'sold'; // closer to bid
  }
  
  return 'midpoint';
}

export function inferTradeIntent(trade: OptionsTradeContext, direction: 'bought' | 'sold' | 'midpoint'): TradeInference {
  if (direction === 'midpoint') return 'Unknown';
  
  // Basic heuristic - if volume > OI, it's likely an opening position
  const isOpening = trade.volume > trade.openInterest;

  if (direction === 'bought' && trade.type === 'call' && isOpening) {
    return 'Opening Long Call';
  }
  
  if (direction === 'bought' && trade.type === 'put' && isOpening) {
    return 'Opening Long Put';
  }
  
  if (direction === 'sold' && trade.type === 'call' && isOpening) {
    return 'Covered Call'; // Or naked call, assuming covered for now
  }
  
  if (direction === 'sold' && trade.type === 'put' && isOpening) {
    return 'Cash-Secured Put';
  }

  if (!isOpening) {
    return 'Closing Position';
  }
  
  return 'Unknown';
}
