import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export class AuthConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: cdk.Stack, id: string) {
    super(scope, id);

    /** Cognito User Pool for email-based authentication. */
    this.userPool = new cognito.UserPool(scope, 'UserPool', {
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
    this.userPoolClient = new cognito.UserPoolClient(scope, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'HandOfMidasWebClient',
      authFlows: {
        userSrp: true,
      },
      generateSecret: false,
    });
  }
}
