import fs from 'node:fs/promises';
import { createWriteStream, createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { PolygonOptionsContract } from '../polygon.js';

const OPTIONS_STORE_DIR = new URL('../../../.options_history/', import.meta.url).pathname;

export interface OptionsChainRecord {
  symbol: string;
  asOf: string; // ISO date string e.g. "2026-08-24"
  expirations: string[];
  contracts: PolygonOptionsContract[];
  quote?: any;
  source: string;
  /**
   * Per-contract shape written by backfillHistoricalOptions.py.
   *   1 (or absent) — close + volume only.
   *   2 — adds `last_quote` (bid/ask and quoted sizes) and `day.trade_count`.
   * Recorded so a reader can tell a chain that genuinely had no quote data
   * from one written before quotes were captured at all. Without it the two
   * are indistinguishable, which is the same ambiguity that let a chain full
   * of fabricated `open_interest: 0` pass for real data for months.
   */
  schemaVersion?: number;
}

/**
 * Get the directory for a specific date
 */
function getDirectoryForDate(dateStr: string): string {
  // Use YYYY-MM-DD
  const folder = dateStr.split('T')[0];
  return path.join(OPTIONS_STORE_DIR, folder);
}

/**
 * Save an options chain for a specific date using gzip compression.
 */
export async function saveOptionsChain(record: OptionsChainRecord): Promise<void> {
  const dir = getDirectoryForDate(record.asOf);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const filePath = path.join(dir, `${record.symbol.toUpperCase()}.json.gz`);
  
  // Serialize JSON and compress
  const jsonString = JSON.stringify(record);
  
  await new Promise<void>((resolve, reject) => {
    zlib.gzip(jsonString, async (err, buffer) => {
      if (err) return reject(err);
      try {
        await fs.writeFile(filePath, buffer);
        resolve();
      } catch (writeErr) {
        reject(writeErr);
      }
    });
  });
}

/**
 * Load an options chain for a specific symbol and date.
 */
export async function loadOptionsChain(symbol: string, dateStr: string): Promise<OptionsChainRecord | null> {
  const dir = getDirectoryForDate(dateStr);
  const filePath = path.join(dir, `${symbol.toUpperCase()}.json.gz`);
  
  if (!existsSync(filePath)) {
    return null;
  }

  return new Promise(async (resolve, reject) => {
    try {
      const buffer = await fs.readFile(filePath);
      zlib.gunzip(buffer, (gunzipErr, unzipped) => {
        if (gunzipErr) return reject(gunzipErr);
        try {
          const record = JSON.parse(unzipped.toString('utf-8')) as OptionsChainRecord;
          resolve(record);
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    } catch (fsErr) {
      reject(fsErr);
    }
  });
}
