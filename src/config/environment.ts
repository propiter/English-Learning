import dotenv from 'dotenv';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Environment variables validation schema
 */
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url('Invalid database URL'),
  REDIS_URL: z.string().url('Invalid Redis URL'),
  
  // Security
  JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters'),
  INTERNAL_API_KEY: z.string().min(32, 'Internal API key must be at least 32 characters'),
  
// OpenAI
OPENAI_API_KEY: z
  .string()
  .optional()
  .refine(val => val === undefined || val.startsWith('sk-'), {
    message: 'Invalid OpenAI API key format',
  }),
OPENAI_MODEL_NAME: z.string().default('gpt-4-turbo').optional(),

// Google AI
GOOGLE_API_KEY: z
  .string()
  .optional()
  .refine(val => val === undefined || val.length > 0, {
    message: 'Google API key must not be empty if set',
  }),
GOOGLE_MODEL_NAME: z.string().default('models/gemini-2.0-flash-lite-preview-02-05').optional(),
GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

// DeepSeek
DEEPSEEK_API_KEY: z
  .string()
  .optional()
  .refine(val => val === undefined || val.length > 0, {
    message: 'DeepSeek API key must not be empty if set',
  }),
DEEPSEEK_MODEL_NAME: z.string().default('deepseek-chat').optional(),
DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com/v1').optional(),
DEEPSEEK_STT_ENABLED: z.string().default('false').optional(),

  // Messaging platforms
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram bot token is required').optional(),
  WHATSAPP_API_URL: z.string().url('Invalid WhatsApp API URL').optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1, 'WhatsApp access token is required').optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WhatsApp verify token is required').optional(),
  
  // Server
  PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_BASE_URL: z.string().url('Invalid API base URL'),
  ALLOWED_ORIGINS: z.string().min(1, 'Allowed origins must be specified'),
  
  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FILE_PATH: z.string().default('./logs'),
  
  // File storage (S3/Minio)
  STORAGE_PROVIDER: z.enum(['aws', 'gcp', 'azure', 'local']).default('aws'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS Access Key ID is required for S3/Minio storage'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS Secret Access Key is required for S3/Minio storage'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string().min(1, 'S3/Minio Bucket name is required'),
  S3_ENDPOINT: z.string().url('A valid S3/Minio endpoint URL is required').optional(),
  S3_FORCE_PATH_STYLE: z.string().transform(v => v === 'true').pipe(z.boolean()).optional(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).pipe(z.number().int().positive()).default('900000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).pipe(z.number().int().positive()).default('100'),
  
  // Audio processing & Evaluation Logic
  MAX_AUDIO_FILE_SIZE_MB: z.string().transform(Number).pipe(z.number().int().positive()).default('10'),
  SUPPORTED_AUDIO_FORMATS: z.string().default('mp3,wav,ogg,m4a'),
  EVALUATOR_MIN_WORD_COUNT: z.string().transform(Number).pipe(z.number().int().positive()).default('5'),
  
  // API timeouts
  OPENAI_API_TIMEOUT: z.string().transform(Number).pipe(z.number().int().positive()).default('60000'),
  TELEGRAM_API_TIMEOUT: z.string().transform(Number).pipe(z.number().int().positive()).default('10000'),
  WHATSAPP_API_TIMEOUT: z.string().transform(Number).pipe(z.number().int().positive()).default('10000'),

  // Conversational AI
  CHAT_HISTORY_WINDOW_SIZE: z.string().transform(Number).pipe(z.number().int().positive()).default('10'),
});

/**
 * Validate and export environment configuration
 */
function validateEnvironment() {
  try {
    const parsedEnv = envSchema.safeParse(process.env);
    if (!parsedEnv.success) {
      const errorMessages = parsedEnv.error.errors.map(err => {
        const varName = err.path.join('.');
        const currentValue = process.env[varName];
        const valueInfo = currentValue ? ` (current value: "${currentValue}")` : ' (not set)';
        return `- ${varName}: ${err.message}${valueInfo}`;
      });
      
      logger.error('Environment variable validation error:');
      logger.error('The following variables have issues:');
      logger.error(errorMessages.join('\n'));
      
      console.error('\n=== CONFIGURATION ERROR ===');
      console.error('The following environment variables have issues:');
      console.error(errorMessages.join('\n'));
      console.error('\nPlease check your .env file and ensure that:');
      console.error('1. All required variables are defined.');
      console.error('2. Values have the correct format (e.g., URLs, keys).');
      console.error('3. There are no extra spaces around the = sign.');
      console.error('==============================\n');
      
      process.exit(1);
    }
    
    logger.info('Environment variables validated successfully');
    return parsedEnv.data;
  } catch (error) {
    logger.error('An unexpected error occurred during environment validation.', { error });
    process.exit(1);
  }
}

export const env = validateEnvironment();

export default env;
