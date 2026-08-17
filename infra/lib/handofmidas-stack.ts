import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';

import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Main infrastructure stack for the Hand of Midas application.
 *
 * Provisions all AWS resources in a single stack:
 * - S3 + CloudFront for static frontend hosting (SPA)
 * - Cognito User Pool for authentication
 * - DynamoDB table (single-table design) with GSIs for options chain queries
 * - Lambda function (Node.js 20, ARM64) for the backend API
 * - ChainRefresh Lambda triggered every 5 min during market hours
 * - WebSocket API Gateway for real-time price/chain push updates
 * - API Gateway HTTP API with JWT authorization
 * - SSM Parameter Store for API key management (Twelve Data + Polygon)
 * - EventBridge scheduled rules for cache refresh and chain snapshotting
 *
 * All resources use DESTROY removal policies for easy teardown.
 */
export class HandOfMidasStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ──────────────────────────────────────────────
    // Tag all resources for cost tracking
    // ──────────────────────────────────────────────
    cdk.Tags.of(this).add('Project', 'HandOfMidas');

    // ──────────────────────────────────────────────
    // A. S3 + CloudFront (Static Frontend Hosting)
    // ──────────────────────────────────────────────

    /** Private S3 bucket for the built frontend assets. */
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /**
     * CloudFront distribution serving the SPA from S3 via Origin Access Control (OAC).
     * Configured with SPA-style error handling: 403/404 → /index.html with HTTP 200.
     */
    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    /** Deploy the built frontend assets to S3, invalidating the CloudFront cache. */
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../frontend/dist'))],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ──────────────────────────────────────────────
    // B. Cognito User Pool
    // ──────────────────────────────────────────────

    /** Cognito User Pool for email-based authentication. */
    // TODO (Institutional): 
    // - Implement strict tenant/organization boundaries (Cognito Groups/Custom Attributes).
    // - Enforce MFA (cognito.Mfa.REQUIRED) instead of OPTIONAL.
    // - Disable selfSignUpEnabled in a true B2B environment.
    // - Configure AWS WAF with rate/abuse controls on the API Gateway.
    // - Enable Point-in-Time Recovery (PITR) on DynamoDB for disaster recovery.
    // - Implement immutable audit trails (e.g. Kinesis Firehose to S3 or DynamoDB Streams).
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'HandOfMidasUserPool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OPTIONAL,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    /** User Pool Client configured for SRP authentication (no client secret). */
    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: 'HandOfMidasWebClient',
      authFlows: {
        userSrp: true,
      },
      generateSecret: false,
    });

    // ──────────────────────────────────────────────
    // C. DynamoDB Table (Single-Table Design)
    // ──────────────────────────────────────────────

    /**
     * Single DynamoDB table using composite primary key (pk + sk).
     * On-demand billing for pay-per-request pricing.
     * TTL enabled on the `ttl` attribute for automatic expiration.
     *
     * Key patterns:
     *   USER#{userId}            / WATCHLIST#{symbol}       — watchlist entries
     *   USER#{userId}            / CONFIG#{symbol}          — chart configs
     *   USER#{userId}            / POSITION#{positionId}    — portfolio positions
     *   CACHE#{symbol}#{interval}/ CACHE                    — OHLCV cache
     *   BASELINE#{symbol}        / {strike}#{expiry}#{side} — anomaly baselines
     *   SNAPSHOT#{symbol}#{date} / SNAPSHOT                 — chain snapshots
     */
    const table = new dynamodb.Table(this, 'Table', {
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
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ──────────────────────────────────────────────
    // F. SSM Parameter Store (API Keys)
    // ──────────────────────────────────────────────

    const ssmTwelveDataPath = '/handofmidas/twelvedata-api-key';
    const ssmPolygonPath = '/handofmidas/polygon-api-key';

    /** Reference to the manually-created SSM parameter for the Twelve Data API key. */
    const twelveDataApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'TwelveDataApiKey',
      { parameterName: ssmTwelveDataPath },
    );

    /**
     * Reference to the manually-created SSM parameter for the Polygon.io API key.
     * Create this before deploying: aws ssm put-parameter --name /handofmidas/polygon-api-key
     *   --value YOUR_KEY --type SecureString
     */
    const polygonApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'PolygonApiKey',
      { parameterName: ssmPolygonPath },
    );

    // ──────────────────────────────────────────────
    // D. Backend API Lambda
    // ──────────────────────────────────────────────

    const sharedEnv = {
      TABLE_NAME: table.tableName,
      SSM_API_KEY_PATH: ssmTwelveDataPath,
      SSM_POLYGON_KEY_PATH: ssmPolygonPath,
      COGNITO_USER_POOL_ID: userPool.userPoolId,
      NODE_OPTIONS: '--enable-source-maps',
    };

    /**
     * Backend Lambda function using NodejsFunction for automatic esbuild bundling.
     * Runs on ARM64 (Graviton) for cost savings, with Node.js 20 runtime.
     */
    const backendFn = new lambdaNodejs.NodejsFunction(this, 'BackendFunction', {
      functionName: 'HandOfMidasBackend',
      entry: path.join(__dirname, '../../backend/src/index.ts'),
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

    table.grantReadWriteData(backendFn);
    twelveDataApiKeyParam.grantRead(backendFn);
    polygonApiKeyParam.grantRead(backendFn);

    // ──────────────────────────────────────────────
    // D2. Chain Refresh Lambda (scheduled)
    // ──────────────────────────────────────────────

    /**
     * Separate Lambda for scheduled options chain snapshotting and baseline updates.
     * Runs every 5 minutes during market hours (09:30-16:00 ET, Mon-Fri).
     * Separate function to avoid sharing timeout budget with API requests.
     */
    const chainRefreshFn = new lambdaNodejs.NodejsFunction(this, 'ChainRefreshFunction', {
      functionName: 'HandOfMidasChainRefresh',
      entry: path.join(__dirname, '../../backend/src/handlers/chainRefresh.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(300), // 5 min timeout for bulk chain refresh
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
      environment: sharedEnv,
    });

    table.grantReadWriteData(chainRefreshFn);
    twelveDataApiKeyParam.grantRead(chainRefreshFn);
    polygonApiKeyParam.grantRead(chainRefreshFn);

    /**
     * EventBridge rule: fire every 5 minutes during market hours (Mon–Fri, 09:30–16:00 ET).
     * ET = UTC-4 (EDT) in summer. 09:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC.
     * Cron: minute 30-59 of hour 13, then every 5 min hours 14-19, stop at 20:00 UTC.
     *
     * For simplicity, we use a broad rule (every 5 min) and let the Lambda check
     * isMarketOpen() to skip execution outside trading hours.
     */
    const chainRefreshRule = new events.Rule(this, 'ChainRefreshRule', {
      ruleName: 'HandOfMidas-ChainRefresh',
      // Every 5 minutes, 13:00-21:00 UTC Mon-Fri (covers 09:00-17:00 ET with buffer)
      schedule: events.Schedule.expression('cron(0/5 13-21 ? * MON-FRI *)'),
      description: 'Triggers options chain refresh every 5 min during market hours',
    });

    chainRefreshRule.addTarget(
      new targets.LambdaFunction(chainRefreshFn),
    );

    // ──────────────────────────────────────────────
    // D2b. Quant Evaluation Lambda (scheduled)
    // ──────────────────────────────────────────────

    /**
     * Separate Lambda that grades finalized predictions against subsequent
     * price action once daily after market close, feeding FACTOR_STATS/
     * SETUP_STATS. Without this running, the composite score's accuracy-based
     * weight multiplier and the self-learning calibration never leave their
     * neutral/conservative defaults, regardless of how many predictions the
     * screener accumulates. Separate function (not the main API Lambda) so a
     * large backlog of ungraded predictions can't run into the 29s API timeout.
     */
    const evaluateQuantFn = new lambdaNodejs.NodejsFunction(this, 'EvaluateQuantFunction', {
      functionName: 'HandOfMidasEvaluateQuant',
      entry: path.join(__dirname, '../../backend/src/handlers/evaluateQuant.ts'),
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

    table.grantReadWriteData(evaluateQuantFn);
    twelveDataApiKeyParam.grantRead(evaluateQuantFn);
    polygonApiKeyParam.grantRead(evaluateQuantFn);

    /**
     * EventBridge rule: once daily, after market close, Mon–Fri.
     * 21:30 UTC = 17:30 ET (EDT, UTC-4) — an hour past the 20:00 UTC close
     * buffer used by ChainRefreshRule, so the day's final daily bar has had
     * time to settle with both Schwab and Yahoo before grading runs.
     */
    const evaluateQuantRule = new events.Rule(this, 'EvaluateQuantRule', {
      ruleName: 'HandOfMidas-EvaluateQuant',
      schedule: events.Schedule.expression('cron(30 21 ? * MON-FRI *)'),
      description: 'Triggers quant prediction grading once daily after market close',
    });

    evaluateQuantRule.addTarget(
      new targets.LambdaFunction(evaluateQuantFn),
    );

    // ──────────────────────────────────────────────
    // D2c. Screener Refresh Lambda (scheduled)
    // ──────────────────────────────────────────────

    /**
     * Separate Lambda that runs the deep-scan screener and caches the result.
     * A full scan (up to 20 candidates through the entire predictive-engine
     * pipeline — bars, options chain, sentiment, 21 factors) measured 3+
     * minutes, which the 29s API Lambda (backendFn) can never complete inside
     * a request. GET /api/screener now only ever reads whatever this last
     * cached; it never runs the scan itself. Same reasoning as
     * evaluateQuantFn: a separate function so this doesn't share the API
     * Lambda's timeout budget.
     */
    const screenerRefreshFn = new lambdaNodejs.NodejsFunction(this, 'ScreenerRefreshFunction', {
      functionName: 'HandOfMidasScreenerRefresh',
      entry: path.join(__dirname, '../../backend/src/handlers/screenerRefresh.ts'),
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

    table.grantReadWriteData(screenerRefreshFn);
    twelveDataApiKeyParam.grantRead(screenerRefreshFn);
    polygonApiKeyParam.grantRead(screenerRefreshFn);

    // Lets the "Refresh Scan" button in the UI hand off an on-demand scan:
    // backendFn invokes this Lambda asynchronously (fire-and-forget) rather
    // than running the 3+ min scan inline, which its own 29s timeout can't
    // accommodate.
    screenerRefreshFn.grantInvoke(backendFn);
    backendFn.addEnvironment('SCREENER_REFRESH_FUNCTION_NAME', screenerRefreshFn.functionName);

    /**
     * One rule per mode, each on its own offset so they don't all invoke in
     * the same minute. A scan measured ~3 min: 'open'/'premarket' at every 5
     * min still leave a buffer between a mode's own firings, but
     * 'momentum'/'highdemand' at every 2 min will commonly overlap with
     * their own still-running previous invocation — Lambda just runs them
     * concurrently, so this is a cost/provider-load tradeoff (more frequent
     * Yahoo/Polygon fan-out), not a correctness issue.
     * 'open'/'momentum'/'highdemand' only matter during the regular session;
     * 'premarket' only during premarket. The handler itself also checks
     * getMarketSession() and no-ops outside its relevant window, so a broad
     * cron range here is safe.
     */
    const screenerModeSchedules: Array<{ mode: 'open' | 'momentum' | 'highdemand' | 'premarket'; cron: string }> = [
      { mode: 'open', cron: 'cron(0/5 13-21 ? * MON-FRI *)' },
      { mode: 'momentum', cron: 'cron(0/2 13-21 ? * MON-FRI *)' },
      { mode: 'highdemand', cron: 'cron(1/2 13-21 ? * MON-FRI *)' },
      { mode: 'premarket', cron: 'cron(0/5 8-13 ? * MON-FRI *)' },
    ];

    for (const { mode, cron } of screenerModeSchedules) {
      const rule = new events.Rule(this, `ScreenerRefreshRule${mode.charAt(0).toUpperCase()}${mode.slice(1)}`, {
        ruleName: `HandOfMidas-ScreenerRefresh-${mode}`,
        schedule: events.Schedule.expression(cron),
        description: `Triggers screener refresh for mode=${mode}`,
      });
      rule.addTarget(
        new targets.LambdaFunction(screenerRefreshFn, {
          event: events.RuleTargetInput.fromObject({ mode }),
        }),
      );
    }

    // ──────────────────────────────────────────────
    // D2d. Diagonal Spread Refresh Lambda (scheduled)
    // ──────────────────────────────────────────────

    /**
     * Same reasoning as ScreenerRefreshFunction: fetching a real near+far
     * options chain per oversold candidate (see diagonalScreenerService.ts —
     * it previously only fetched the nearest expiry, so no leg could ever be
     * found) measured ~68s, past the 29s API Lambda timeout. Separate
     * function, own cron, own cache key; GET /api/screener/diagonal only
     * reads it. LEAP diagonals are a much slower-moving setup than the
     * intraday screener modes, so a single 15-min cadence is enough.
     */
    const diagonalRefreshFn = new lambdaNodejs.NodejsFunction(this, 'DiagonalRefreshFunction', {
      functionName: 'HandOfMidasDiagonalRefresh',
      entry: path.join(__dirname, '../../backend/src/handlers/diagonalRefresh.ts'),
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

    table.grantReadWriteData(diagonalRefreshFn);
    twelveDataApiKeyParam.grantRead(diagonalRefreshFn);
    polygonApiKeyParam.grantRead(diagonalRefreshFn);

    diagonalRefreshFn.grantInvoke(backendFn);
    backendFn.addEnvironment('DIAGONAL_REFRESH_FUNCTION_NAME', diagonalRefreshFn.functionName);

    const diagonalRefreshRule = new events.Rule(this, 'DiagonalRefreshRule', {
      ruleName: 'HandOfMidas-DiagonalRefresh',
      schedule: events.Schedule.expression('cron(0,15,30,45 13-21 ? * MON-FRI *)'),
      description: 'Triggers diagonal-spread screener refresh every 15 min during market hours',
    });
    diagonalRefreshRule.addTarget(new targets.LambdaFunction(diagonalRefreshFn));

    // ──────────────────────────────────────────────
    // D2e. Value / Growth / ETF Screener Refresh Lambdas (scheduled)
    // ──────────────────────────────────────────────

    /**
     * Same "separate scheduled Lambda + cache-only route" reasoning as
     * DiagonalRefreshFunction, but for fundamentals-driven screens. Unlike
     * options chains, P/E ratios, growth estimates, and multi-month ETF
     * returns don't move intraday — so these run once daily at market open
     * (staggered a few minutes apart to avoid concurrent cold starts)
     * instead of every 15 minutes, which also meaningfully cuts Yahoo API
     * load and Lambda invocation cost vs. matching the diagonal cadence.
     */
    const valueRefreshFn = new lambdaNodejs.NodejsFunction(this, 'ValueRefreshFunction', {
      functionName: 'HandOfMidasValueRefresh',
      entry: path.join(__dirname, '../../backend/src/handlers/valueRefresh.ts'),
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

    table.grantReadWriteData(valueRefreshFn);
    twelveDataApiKeyParam.grantRead(valueRefreshFn);
    polygonApiKeyParam.grantRead(valueRefreshFn);

    valueRefreshFn.grantInvoke(backendFn);
    backendFn.addEnvironment('VALUE_REFRESH_FUNCTION_NAME', valueRefreshFn.functionName);

    const valueRefreshRule = new events.Rule(this, 'ValueRefreshRule', {
      ruleName: 'HandOfMidas-ValueRefresh',
      schedule: events.Schedule.expression('cron(30 13 ? * MON-FRI *)'),
      description: 'Triggers value screener refresh once daily at market open',
    });
    valueRefreshRule.addTarget(new targets.LambdaFunction(valueRefreshFn));

    const growthRefreshFn = new lambdaNodejs.NodejsFunction(this, 'GrowthRefreshFunction', {
      functionName: 'HandOfMidasGrowthRefresh',
      entry: path.join(__dirname, '../../backend/src/handlers/growthRefresh.ts'),
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

    table.grantReadWriteData(growthRefreshFn);
    twelveDataApiKeyParam.grantRead(growthRefreshFn);
    polygonApiKeyParam.grantRead(growthRefreshFn);

    growthRefreshFn.grantInvoke(backendFn);
    backendFn.addEnvironment('GROWTH_REFRESH_FUNCTION_NAME', growthRefreshFn.functionName);

    const growthRefreshRule = new events.Rule(this, 'GrowthRefreshRule', {
      ruleName: 'HandOfMidas-GrowthRefresh',
      schedule: events.Schedule.expression('cron(35 13 ? * MON-FRI *)'),
      description: 'Triggers growth screener refresh once daily at market open',
    });
    growthRefreshRule.addTarget(new targets.LambdaFunction(growthRefreshFn));

    const etfRefreshFn = new lambdaNodejs.NodejsFunction(this, 'EtfRefreshFunction', {
      functionName: 'HandOfMidasEtfRefresh',
      entry: path.join(__dirname, '../../backend/src/handlers/etfRefresh.ts'),
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

    table.grantReadWriteData(etfRefreshFn);
    twelveDataApiKeyParam.grantRead(etfRefreshFn);
    polygonApiKeyParam.grantRead(etfRefreshFn);

    etfRefreshFn.grantInvoke(backendFn);
    backendFn.addEnvironment('ETF_REFRESH_FUNCTION_NAME', etfRefreshFn.functionName);

    const etfRefreshRule = new events.Rule(this, 'EtfRefreshRule', {
      ruleName: 'HandOfMidas-EtfRefresh',
      schedule: events.Schedule.expression('cron(40 13 ? * MON-FRI *)'),
      description: 'Triggers ETF outperformance screener refresh once daily at market open',
    });
    etfRefreshRule.addTarget(new targets.LambdaFunction(etfRefreshFn));

    // ──────────────────────────────────────────────
    // D3. WebSocket Lambda
    // ──────────────────────────────────────────────

    /**
     * DynamoDB table for tracking active WebSocket connections.
     * pk = connectionId, TTL = 24 hours (connections cleaned up on $disconnect).
     */
    const connectionsTable = new dynamodb.Table(this, 'WebSocketConnectionsTable', {
      tableName: 'HandOfMidasConnections',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * WebSocket handler Lambda. Manages $connect/$disconnect and subscription messages.
     * The Lambda ARN is needed to wire the WebSocket API, so we create it before the API.
     */
    const wsFn = new lambdaNodejs.NodejsFunction(this, 'WebSocketFunction', {
      functionName: 'HandOfMidasWebSocket',
      entry: path.join(__dirname, '../../backend/src/handlers/websocket.ts'),
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
        CONNECTIONS_TABLE: connectionsTable.tableName,
      },
    });

    connectionsTable.grantReadWriteData(wsFn);
    table.grantReadData(wsFn);

    // ──────────────────────────────────────────────
    // E. API Gateway HTTP API
    // ──────────────────────────────────────────────

    /** Cognito JWT authorizer for API Gateway HTTP API. */
    const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
    });

    /** Lambda integration for the HTTP API. */
    const lambdaIntegration = new HttpLambdaIntegration('BackendIntegration', backendFn);

    /** HTTP API with CORS configured for development. */
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'HandOfMidasApi',
      corsPreflight: {
        // Replace with the production CloudFront/custom-domain origin when deploying.
        allowOrigins: ['https://' + distribution.distributionDomainName],
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

    /** Catch-all route proxying all /api/* requests to the Lambda with JWT authorization. */
    httpApi.addRoutes({
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

    // ──────────────────────────────────────────────
    // E2. WebSocket API Gateway
    // ──────────────────────────────────────────────

    /**
     * API Gateway WebSocket API for real-time push updates.
     * Routes: $connect, $disconnect, $default
     * Clients connect and send: { action: 'subscribe', symbols: ['AAPL'] }
     */
    const wsApi = new apigwv2.CfnApi(this, 'WebSocketApi', {
      name: 'HandOfMidasWebSocketApi',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    // Lambda permission for WebSocket API to invoke the function
    wsFn.addPermission('WebSocketInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`,
    });

    const wsIntegrationUri = `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${wsFn.functionArn}/invocations`;

    // $connect route
    const connectIntegration = new apigwv2.CfnIntegration(this, 'WsConnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: wsIntegrationUri,
    });

    new apigwv2.CfnRoute(this, 'WsConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    });

    // $disconnect route
    const disconnectIntegration = new apigwv2.CfnIntegration(this, 'WsDisconnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: wsIntegrationUri,
    });

    new apigwv2.CfnRoute(this, 'WsDisconnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$disconnect',
      authorizationType: 'NONE',
      target: `integrations/${disconnectIntegration.ref}`,
    });

    // $default route
    const defaultIntegration = new apigwv2.CfnIntegration(this, 'WsDefaultIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: wsIntegrationUri,
    });

    new apigwv2.CfnRoute(this, 'WsDefaultRoute', {
      apiId: wsApi.ref,
      routeKey: '$default',
      authorizationType: 'NONE',
      target: `integrations/${defaultIntegration.ref}`,
    });

    // Deploy the WebSocket API to 'prod' stage
    const wsStage = new apigwv2.CfnStage(this, 'WebSocketStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      autoDeploy: true,
    });

    // Grant the WebSocket Lambda permission to post messages back to connected clients
    wsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`],
    }));

    // Store WebSocket endpoint URL in Lambda env (for fan-out from chainRefresh)
    const wsEndpoint = `https://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/${wsStage.stageName}`;
    chainRefreshFn.addEnvironment('WEBSOCKET_ENDPOINT', wsEndpoint);
    chainRefreshFn.addEnvironment('CONNECTIONS_TABLE', connectionsTable.tableName);
    connectionsTable.grantReadData(chainRefreshFn);

    // Allow chainRefresh to post to WebSocket connections
    chainRefreshFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`],
    }));

    // ──────────────────────────────────────────────
    // G. EventBridge Scheduled Cache Refresh
    // ──────────────────────────────────────────────

    /**
     * EventBridge rule that triggers the main Lambda every hour for OHLCV cache refresh.
     */
    const scheduleRule = new events.Rule(this, 'CacheRefreshRule', {
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

    // ──────────────────────────────────────────────
    // H. Stack Outputs
    // ──────────────────────────────────────────────

    new cdk.CfnOutput(this, 'CloudFrontURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront distribution URL for the frontend',
    });

    new cdk.CfnOutput(this, 'ApiURL', {
      value: httpApi.apiEndpoint,
      description: 'API Gateway HTTP API endpoint',
    });

    new cdk.CfnOutput(this, 'WebSocketURL', {
      value: `wss://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/${wsStage.stageName}`,
      description: 'WebSocket API endpoint for real-time updates',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'Region', {
      value: this.region,
      description: 'Deployment region',
    });

    new cdk.CfnOutput(this, 'PolygonKeyInstructions', {
      value: `aws ssm put-parameter --name ${ssmPolygonPath} --value YOUR_POLYGON_KEY --type SecureString --overwrite`,
      description: 'Command to set your Polygon.io API key in SSM',
    });
  }
}
