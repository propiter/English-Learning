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
  OPENAI_API_KEY: z.string().startsWith('sk-', 'Invalid OpenAI API key format'),
  
  // External APIs
  EVALUATION_API_URL: z.string().url('Invalid evaluation API URL'),
  EVALUATION_API_KEY: z.string().min(1, 'Evaluation API key is required'),
  
  // Messaging platforms
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram bot token is required'),
  WHATSAPP_API_URL: z.string().url('Invalid WhatsApp API URL'),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1, 'WhatsApp access token is required'),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WhatsApp verify token is required'),
  
  // Server
  PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_BASE_URL: z.string().url('Invalid API base URL'),
  ALLOWED_ORIGINS: z.string().min(1, 'Allowed origins must be specified'),
  
  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FILE_PATH: z.string().default('./logs'),
  
  // File storage
  STORAGE_PROVIDER: z.enum(['aws', 'gcp', 'azure', 'local']).default('aws'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string().optional(),
  
  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).pipe(z.number().int().positive()).default('900000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).pipe(z.number().int().positive()).default('100'),
  
  // Audio processing
  MAX_AUDIO_FILE_SIZE_MB: z.string().transform(Number).pipe(z.number().int().positive()).default('10'),
  SUPPORTED_AUDIO_FORMATS: z.string().default('mp3,wav,ogg,m4a'),
  
  // API timeouts
  EVALUATION_API_TIMEOUT: z.string().transform(Number).pipe(z.number().int().positive()).default('30000'),
  OPENAI_API_TIMEOUT: z.string().transform(Number).pipe(z.number().int().positive()).default('60000'),
  TELEGRAM_API_TIMEOUT: z.string().transform(Number).pipe(z.number().int().positive()).default('10000'),
  WHATSAPP_API_TIMEOUT: z.string().transform(Number).pipe(z.number().int().positive()).default('10000'),
});

/**
 * Validate and export environment configuration
 */
function validateEnvironment() {
  try {
    const env = envSchema.parse(process.env);
    logger.info('Environment variables validated successfully');
    return env;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map(err => {
        const varName = err.path.join('.');
        const currentValue = process.env[varName];
        const valueInfo = currentValue ? ` (current value: "${currentValue}")` : ' (not set)';
        return `- ${varName}: ${err.message}${valueInfo}`;
      });
      
      logger.error('Error de validación de variables de entorno:');
      logger.error('Las siguientes variables tienen problemas:');
      logger.error(errorMessages.join('\n'));
      
      console.error('\n=== ERROR DE CONFIGURACIÓN ===');
      console.error('Las siguientes variables de entorno tienen problemas:');
      console.error(errorMessages.join('\n'));
      console.error('\nPor favor, verifica tu archivo .env y asegúrate de que:');
      console.error('1. Todas las variables requeridas estén definidas');
      console.error('2. Los valores tengan el formato correcto');
      console.error('3. No haya espacios en blanco alrededor de los signos =');
      console.error('4. Las URLs comiencen con http:// o https:// según corresponda');
      console.error('==============================\n');
      
      process.exit(1);
    }
    throw error;
  }
}

export const env = validateEnvironment();

export default env;