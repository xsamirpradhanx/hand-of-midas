import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { OptionsChainRecord } from './optionsStore.js';

const s3 = new S3Client({});
const BUCKET_NAME = process.env['S3_OPTIONS_BUCKET'] ?? 'handofmidas-options-history';

/**
 * Uploads a compressed options chain to S3.
 * Key format: options/{symbol}/{date}.json.gz
 */
export async function uploadOptionsChainToS3(chain: OptionsChainRecord): Promise<void> {
  const symbol = chain.symbol.toUpperCase();
  const dateStr = chain.asOf.split('T')[0];
  const key = `options/${symbol}/${dateStr}.json.gz`;

  const jsonStr = JSON.stringify(chain);
  const compressed = gzipSync(jsonStr);

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: compressed,
    ContentType: 'application/json',
    ContentEncoding: 'gzip',
  });

  await s3.send(command);
}

/**
 * Lists every date ("YYYY-MM-DD") this symbol has a stored chain for.
 */
export async function listOptionsChainDates(symbol: string): Promise<string[]> {
  const prefix = `options/${symbol.toUpperCase()}/`;
  const dates: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of response.Contents ?? []) {
      const match = obj.Key?.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})\.json\.gz$/);
      if (match) dates.push(match[1]!);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return dates.sort();
}

/**
 * Downloads and decompresses an options chain from S3.
 */
export async function downloadOptionsChainFromS3(symbol: string, dateStr: string): Promise<OptionsChainRecord | null> {
  const sym = symbol.toUpperCase();
  const key = `options/${sym}/${dateStr}.json.gz`;

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const response = await s3.send(command);
    if (!response.Body) return null;

    const compressed = await response.Body.transformToByteArray();
    const decompressed = gunzipSync(compressed).toString('utf-8');
    return JSON.parse(decompressed) as OptionsChainRecord;
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
      return null;
    }
    throw err;
  }
}
