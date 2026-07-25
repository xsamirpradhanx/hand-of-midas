import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DatabaseConstruct extends Construct {
  public readonly table: dynamodb.Table;
  public readonly connectionsTable: dynamodb.Table;

  constructor(scope: cdk.Stack, id: string) {
    super(scope, id);

    /**
     * Single DynamoDB table using composite primary key (pk + sk).
     * On-demand billing for pay-per-request pricing.
     * TTL enabled on the `ttl` attribute for automatic expiration.
     */
    this.table = new dynamodb.Table(scope, 'Table', {
      tableName: 'HandOfMidasTable',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * GSI1: query options chain snapshots by underlying symbol + date.
     * gsi1pk = 'SNAPSHOT#{symbol}', gsi1sk = '{date}#{expiry}'
     */
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /**
     * DynamoDB table for tracking active WebSocket connections.
     * pk = connectionId, TTL = 24 hours (connections cleaned up on $disconnect).
     */
    this.connectionsTable = new dynamodb.Table(scope, 'WebSocketConnectionsTable', {
      tableName: 'HandOfMidasConnections',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
