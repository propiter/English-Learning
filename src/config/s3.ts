import { S3Client } from "@aws-sdk/client-s3";
import env from './environment.js';
import { logger } from "../utils/logger.js";

const s3Config: any = {
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
};

// If a custom endpoint is defined (for Minio), use it.
if (env.S3_ENDPOINT) {
  s3Config.endpoint = env.S3_ENDPOINT;
  s3Config.forcePathStyle = env.S3_FORCE_PATH_STYLE;
  logger.info('S3 client configured for Minio/custom endpoint.', { endpoint: env.S3_ENDPOINT });
} else {
  logger.info('S3 client configured for AWS S3.');
}

export const s3Client = new S3Client(s3Config);
