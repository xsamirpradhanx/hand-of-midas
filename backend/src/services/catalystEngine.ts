// backend/src/services/catalystEngine.ts

export type Sentiment = 'Bullish' | 'Bearish' | 'Neutral';
export type CatalystSeverity = number; // 0-100

export interface CatalystEvent {
  headline: string;
  source: string;
  timestamp: string;
  sentiment: Sentiment;
  severity: CatalystSeverity;
  classification: string;
  dilutionRisk?: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  expectedPriceImpact: string;
}

/**
 * Parses news articles and SEC filings to extract structured catalyst data.
 * This is a stub implementation. In a production system, this would involve 
 * NLP or an LLM call to perform entity extraction and sentiment analysis.
 */
export async function analyzeCatalyst(text: string, source: string): Promise<CatalystEvent> {
  const lowerText = text.toLowerCase();
  
  let sentiment: Sentiment = 'Neutral';
  let severity: CatalystSeverity = 10;
  let classification = 'General News';
  let dilutionRisk: CatalystEvent['dilutionRisk'] = 'NONE';
  let expectedPriceImpact = 'Minimal';

  // Basic keyword-based heuristic as a placeholder
  if (lowerText.includes('offering') || lowerText.includes('atm') || lowerText.includes('dilution')) {
    sentiment = 'Bearish';
    severity = 90;
    classification = 'Financing';
    dilutionRisk = 'HIGH';
    expectedPriceImpact = 'Significant Downside';
  } else if (lowerText.includes('earnings') && lowerText.includes('beat')) {
    sentiment = 'Bullish';
    severity = 85;
    classification = 'Earnings Beat';
    expectedPriceImpact = 'Significant Upside';
  } else if (lowerText.includes('fda') && lowerText.includes('approved')) {
    sentiment = 'Bullish';
    severity = 95;
    classification = 'Regulatory Approval';
    expectedPriceImpact = 'Massive Upside';
  }

  return {
    headline: text.length > 100 ? text.substring(0, 100) + '...' : text,
    source,
    timestamp: new Date().toISOString(),
    sentiment,
    severity,
    classification,
    dilutionRisk,
    expectedPriceImpact
  };
}
