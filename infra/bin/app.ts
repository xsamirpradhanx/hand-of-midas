#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { HandOfMidasStack } from '../lib/handofmidas-stack';

const app = new cdk.App();
new HandOfMidasStack(app, 'HandOfMidasStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Hand of Midas - Personal Stock Watchlist & Charting App',
});
