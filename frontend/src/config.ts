/**
 * Application configuration loaded from environment variables.
 *
 * All values fall back to sensible defaults for local development.
 *
 * @module config
 */
export const config = {
  /** Base URL for the REST API */
  apiUrl: import.meta.env.VITE_API_URL || '/api',
  /** AWS Cognito User Pool ID */
  cognitoUserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
  /** AWS Cognito App Client ID */
  cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
  /** AWS region */
  region: import.meta.env.VITE_AWS_REGION || 'us-east-1',
};
