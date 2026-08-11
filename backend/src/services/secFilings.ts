// backend/src/services/secFilings.ts

import { analyzeCatalyst, CatalystEvent } from './catalystEngine.js';

/**
 * Service to monitor and ingest SEC filings (8-K, 10-Q, 10-K, S-3, etc.).
 * Service to fetch and process recent SEC filings using Yahoo Finance.
 */

export interface SECFiling {
  ticker: string;
  formType: string;
  filingDate: string;
  accessionNumber: string;
  documentUrl: string;
  description: string;
}

import { yf } from './yahoo.js';

export async function fetchRecentFilings(ticker: string): Promise<SECFiling[]> {
  try {
    const summary = await yf.quoteSummary(ticker, { modules: ['secFilings'] });
    const filings = summary.secFilings?.filings || [];
    
    return filings.map((f: any) => ({
      ticker,
      formType: f.type || 'Unknown',
      filingDate: f.date || '',
      accessionNumber: f.edgarUrl ? f.edgarUrl.split('/').pop() || '' : '',
      documentUrl: f.edgarUrl || '',
      description: f.title || ''
    }));
  } catch (error) {
    console.error(`Failed to fetch SEC filings for ${ticker} via Yahoo:`, error);
    return [];
  }
}


export async function processFilingForCatalysts(filing: SECFiling): Promise<CatalystEvent> {
  // Stub: In reality, we'd fetch the documentUrl text and parse it.
  // For now, we just pass the description/formType to the catalyst engine.
  const textToAnalyze = `${filing.formType} filing: ${filing.description}`;
  return analyzeCatalyst(textToAnalyze, 'SEC Edgar');
}
