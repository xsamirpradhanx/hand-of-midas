import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ApiConstructProps {
  table: dynamodb.Table;
  connectionsTable: dynamodb.Table;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  distributionDomainName: string;
}

export class ApiConstruct extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly wsApiRef: string;
  public readonly wsStageName: string;

  constructor(scope: cdk.Stack, id: string, props: ApiConstructProps) {
    super(scope, id);

    const ssmTwelveDataPath = '/handofmidas/twelvedata-api-key';
    const ssmPolygonPath = '/handofmidas/polygon-api-key';

    const twelveDataApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      scope,
      'TwelveDataApiKey',
      { parameterName: ssmTwelveDataPath },
    );

    const polygonApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      scope,
      'PolygonApiKey',
      { parameterName: ssmPolygonPath },
    );

    const sharedEnv = {
      TABLE_NAME: props.table.tableName,
      SSM_API_KEY_PATH: ssmTwelveDataPath,
      SSM_POLYGON_KEY_PATH: ssmPolygonPath,
      COGNITO_USER_POOL_ID: props.userPool.userPoolId,
      NODE_OPTIONS: '--enable-source-maps',
    };

    /**
     * Backend Lambda function using NodejsFunction for automatic esbuild bundling.
     */
    const backendFn = new lambdaNodejs.NodejsFunction(scope, 'BackendFunction', {
      functionName: 'HandOfMidasBackend',
      entry: path.join(__dirname, '../../../backend/src/index.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(29),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      environment: sharedEnv,
    });

    props.table.grantReadWriteData(backendFn);
    twelveDataApiKeyParam.grantRead(backendFn);
    polygonApiKeyParam.grantRead(backendFn);

    /**
     * Chain Refresh Lambda (scheduled)
     */
    const chainRefreshFn = new lambdaNodejs.NodejsFunction(scope, 'ChainRefreshFunction', {
      functionName: 'HandOfMidasChainRefresh',
      entry: path.join(__dirname, '../../../backend/src/handlers/chainRefresh.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(300),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      environment: sharedEnv,
    });

    props.table.grantReadWriteData(chainRefreshFn);
    twelveDataApiKeyParam.grantRead(chainRefreshFn);
    polygonApiKeyParam.grantRead(chainRefreshFn);

    const chainRefreshRule = new events.Rule(scope, 'ChainRefreshRule', {
      ruleName: 'HandOfMidas-ChainRefresh',
      schedule: events.Schedule.expression('cron(0/5 13-21 ? * MON-FRI *)'),
      description: 'Triggers options chain refresh every 5 min during market hours',
    });

    chainRefreshRule.addTarget(
      new targets.LambdaFunction(chainRefreshFn),
    );

    /**
     * WebSocket Lambda
     */
    const wsFn = new lambdaNodejs.NodejsFunction(scope, 'WebSocketFunction', {
      functionName: 'HandOfMidasWebSocket',
      entry: path.join(__dirname, '../../../backend/src/handlers/websocket.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(29),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        ...sharedEnv,
        CONNECTIONS_TABLE: props.connectionsTable.tableName,
      },
    });

    props.connectionsTable.grantReadWriteData(wsFn);
    props.table.grantReadData(wsFn);

    /**
     * API Gateway HTTP API
     */
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', props.userPool, {
      userPoolClients: [props.userPoolClient],
    });

    const lambdaIntegration = new HttpLambdaIntegration('BackendIntegration', backendFn);

    this.httpApi = new apigwv2.HttpApi(scope, 'HttpApi', {
      apiName: 'HandOfMidasApi',
      corsPreflight: {
        allowOrigins: ['https://' + props.distributionDomainName],
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
      },
    });

    this.httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: lambdaIntegration,
      authorizer,
    });

    /**
     * WebSocket API Gateway
     */
    const wsApi = new apigwv2.CfnApi(scope, 'WebSocketApi', {
      name: 'HandOfMidasWebSocketApi',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });
    this.wsApiRef = wsApi.ref;

    wsFn.addPermission('WebSocketInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${cdk.Stack.of(scope).region}:${cdk.Stack.of(scope).account}:${wsApi.ref}/*`,
    });

    const wsIntegrationUri = `arn:aws:apigateway:${cdk.Stack.of(scope).region}:lambda:path/2015-03-31/functions/${wsFn.functionArn}/invocations`;

    const connectIntegration = new apigwv2.CfnIntegration(scope, 'WsConnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: wsIntegrationUri,
    });

    new apigwv2.CfnRoute(scope, 'WsConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    });

    const disconnectIntegration = new apigwv2.CfnIntegration(scope, 'WsDisconnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: wsIntegrationUri,
    });

    new apigwv2.CfnRoute(scope, 'WsDisconnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$disconnect',
      authorizationType: 'NONE',
      target: `integrations/${disconnectIntegration.ref}`,
    });

    const defaultIntegration = new apigwv2.CfnIntegration(scope, 'WsDefaultIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: wsIntegrationUri,
    });

    new apigwv2.CfnRoute(scope, 'WsDefaultRoute', {
      apiId: wsApi.ref,
      routeKey: '$default',
      authorizationType: 'NONE',
      target: `integrations/${defaultIntegration.ref}`,
    });

    const wsStage = new apigwv2.CfnStage(scope, 'WebSocketStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      autoDeploy: true,
    });
    this.wsStageName = wsStage.stageName;

    wsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${cdk.Stack.of(scope).region}:${cdk.Stack.of(scope).account}:${wsApi.ref}/*`],
    }));

    const wsEndpoint = `https://${wsApi.ref}.execute-api.${cdk.Stack.of(scope).region}.amazonaws.com/${wsStage.stageName}`;
    chainRefreshFn.addEnvironment('WEBSOCKET_ENDPOINT', wsEndpoint);
    chainRefreshFn.addEnvironment('CONNECTIONS_TABLE', props.connectionsTable.tableName);
    props.connectionsTable.grantReadData(chainRefreshFn);

    chainRefreshFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${cdk.Stack.of(scope).region}:${cdk.Stack.of(scope).account}:${wsApi.ref}/*`],
    }));

    /**
     * EventBridge Scheduled Cache Refresh
     */
    const scheduleRule = new events.Rule(scope, 'CacheRefreshRule', {
      ruleName: 'HandOfMidas-CacheRefresh',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Triggers the Hand of Midas Lambda hourly to refresh cached stock data',
    });

    scheduleRule.addTarget(
      new targets.LambdaFunction(backendFn, {
        event: events.RuleTargetInput.fromObject({
          source: 'scheduled',
          action: 'refresh-cache',
        }),
      }),
    );
  }
}
