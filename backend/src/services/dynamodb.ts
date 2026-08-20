import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBBaseItem } from '../types.js';

// ---------------------------------------------------------------------------
// Client initialisation — lives OUTSIDE the handler for connection reuse
// across warm Lambda invocations.
// ---------------------------------------------------------------------------

const rawClient = new DynamoDBClient({});

/**
 * DynamoDB Document Client configured with marshalling defaults.
 * - `removeUndefinedValues` prevents accidental SDK errors.
 * - `convertEmptyValues` turns empty strings into `null` to satisfy DDB.
 */
const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: true,
  },
});

/** Table name is injected at deploy-time via the TABLE_NAME env var. */
const TABLE_NAME = process.env['TABLE_NAME'] ?? 'HandOfMidasTable';

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve a single item by its composite primary key.
 *
 * @param pk - Partition key value.
 * @param sk - Sort key value.
 * @returns The item if found, otherwise `undefined`.
 */
export async function getItem<T extends DynamoDBBaseItem>(
  pk: string,
  sk: string,
): Promise<T | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
    }),
  );
  return result.Item as T | undefined;
}

/**
 * Recursively sanitize objects before putting them into DynamoDB.
 * Prevents "Number underflow" errors by converting extremely small numbers to 0.
 * Also converts NaN and Infinity to null, as DynamoDB doesn't support them.
 */
function sanitizeItem<T>(item: T): T {
  if (item === null || typeof item === 'undefined') {
    return item;
  }
  if (typeof item === 'number') {
    if (Number.isNaN(item) || !Number.isFinite(item)) {
      return null as any;
    }
    if (item !== 0 && Math.abs(item) < 1e-100) {
      return 0 as any;
    }
    return item;
  }
  if (Array.isArray(item)) {
    return item.map(sanitizeItem) as any;
  }
  if (typeof item === 'object') {
    if (Buffer.isBuffer(item) || item instanceof Uint8Array) {
      return item;
    }
    const sanitized: any = {};
    for (const [key, value] of Object.entries(item)) {
      sanitized[key] = sanitizeItem(value);
    }
    return sanitized as T;
  }
  return item;
}

/**
 * Write (put) an item into the table.
 * Supports optimistic concurrency if expectedVersion is provided.
 *
 * @param item - The full item to store (must include PK and SK).
 * @param expectedVersion - Optional version to assert for optimistic locking.
 */
export async function putItem<T extends DynamoDBBaseItem>(
  item: T,
  expectedVersion?: number,
): Promise<void> {
  const sanitizedItem = sanitizeItem(item);
  
  const params: any = {
    TableName: TABLE_NAME,
    Item: sanitizedItem,
  };

  if (expectedVersion !== undefined) {
    // Optimistic locking: update succeeds only if the existing item has the same version
    // or if the item does not exist (expectedVersion = 0 could imply new item, but let's be strict:
    // usually if expectedVersion is provided, we require it to match, or if 0, require it not to exist).
    if (expectedVersion === 0) {
      params.ConditionExpression = 'attribute_not_exists(pk)';
    } else {
      params.ConditionExpression = 'attribute_not_exists(pk) OR version = :expectedVersion';
      params.ExpressionAttributeValues = { ':expectedVersion': expectedVersion };
    }
  }

  await docClient.send(new PutCommand(params));
}

/**
 * Delete a single item by its composite primary key.
 *
 * @param pk - Partition key value.
 * @param sk - Sort key value.
 */
export async function deleteItem(pk: string, sk: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
    }),
  );
}

/**
 * Query all items sharing the same partition key, optionally filtering
 * by a sort-key prefix using `begins_with`.
 *
 * Automatically paginates through all results so the caller always
 * receives the complete dataset.
 *
 * @param pk       - Partition key value to query.
 * @param skPrefix - Optional sort key prefix for a `begins_with` condition.
 * @returns An array of matching items.
 */
export async function queryItems<T extends DynamoDBBaseItem>(
  pk: string,
  skPrefix?: string,
): Promise<T[]> {
  const items: T[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const keyCondition = skPrefix
      ? 'pk = :pk AND begins_with(sk, :sk)'
      : 'pk = :pk';

    const expressionValues: Record<string, string> = { ':pk': pk };
    if (skPrefix) {
      expressionValues[':sk'] = skPrefix;
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: expressionValues,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    if (result.Items) {
      items.push(...(result.Items as T[]));
    }

    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  return items;
}

/**
 * Query a contiguous sort-key range within one partition.
 *
 * `queryItems` can only express a prefix, which forces a caller wanting
 * "bars from 2010 to 2015" to read every chunk in the partition and filter in
 * memory. For the historical bar store that is the difference between reading
 * six items and reading forty years of them, so the range condition belongs in
 * DynamoDB rather than in the caller.
 *
 * Both bounds are inclusive, matching DynamoDB's BETWEEN semantics.
 */
export async function queryItemsBetween<T extends DynamoDBBaseItem>(
  pk: string,
  skFrom: string,
  skTo: string,
): Promise<T[]> {
  const items: T[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': pk, ':from': skFrom, ':to': skTo },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    if (result.Items) {
      items.push(...(result.Items as T[]));
    }

    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  return items;
}

/**
 * Perform a full table scan with an optional filter expression.
 * WARNING: Use sparingly — scans consume read capacity proportional to table size.
 * This is only used by background jobs (chainRefresh) that run infrequently.
 *
 * @param options - Optional FilterExpression and ExpressionAttributeValues.
 * @returns All matching items across all partitions.
 */
export async function scanItems<T extends DynamoDBBaseItem>(options?: {
  FilterExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  ExpressionAttributeNames?: Record<string, string>;
}): Promise<T[]> {
  const items: T[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: options?.FilterExpression,
        ExpressionAttributeValues: options?.ExpressionAttributeValues,
        ExpressionAttributeNames: options?.ExpressionAttributeNames,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    if (result.Items) {
      items.push(...(result.Items as T[]));
    }

    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
}
