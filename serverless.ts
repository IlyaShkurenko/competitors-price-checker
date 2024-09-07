import type { AWS } from '@serverless/typescript';

import checkPrices from '@functions/checkPrices';

import * as dotenv from 'dotenv';

dotenv.config();

const serverlessConfiguration: AWS = {
  service: 'competitors-price-checker',
  frameworkVersion: '3',
  plugins: ['serverless-esbuild', 'serverless-offline', 'serverless-dotenv-plugin'],
  provider: {
    name: 'aws',
    runtime: 'nodejs20.x',
    apiGateway: {
      minimumCompressionSize: 1024,
      shouldStartNameWithService: true,
    },
    environment: {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      NODE_OPTIONS: '--enable-source-maps --stack-trace-limit=1000',
      S3_BUCKET_UPLOAD_NAME: process.env.S3_BUCKET_UPLOAD_NAME,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    },
    iamRoleStatements: [
      {
        Effect: 'Allow',
        Action: [
          's3:PutObject',
        ],
        Resource: `arn:aws:s3:::${process.env.S3_BUCKET_UPLOAD_NAME}/*`,
      },
    ],
  },
  functions: { 
    checkPrices: {
      handler: checkPrices.handler,
      timeout: 600,
    },
  },
  package: { individually: true },
  custom: {
    esbuild: {
      bundle: true,
      minify: false,
      sourcemap: true,
      exclude: [],
      target: 'node20',
      define: { 'require.resolve': undefined },
      platform: 'node',
      concurrency: 10,
    },
    'serverless-offline': {
      port: 3000,
      stage: '',
      httpPort: 3000,
      noPrependStageInUrl: true,
    },
  },
};

module.exports = serverlessConfiguration;