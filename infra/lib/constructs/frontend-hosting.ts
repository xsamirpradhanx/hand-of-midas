import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

export class FrontendHostingConstruct extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: cdk.Stack, id: string) {
    super(scope, id);

    /** Private S3 bucket for the built frontend assets. */
    const frontendBucket = new s3.Bucket(scope, 'FrontendBucket', {
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
    this.distribution = new cloudfront.Distribution(scope, 'FrontendDistribution', {
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
    new s3deploy.BucketDeployment(scope, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../../frontend/dist'))],
      destinationBucket: frontendBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });
  }
}
