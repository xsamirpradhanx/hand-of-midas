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
 * Write (put) an item into the table.
 * This performs an unconditional overwrite if the key already exists.
 *
 * @param item - The full item to store (must include PK and SK).
 */
export async function putItem<T extends DynamoDBBaseItem>(
  item: T,
): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
    }),
  );
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
