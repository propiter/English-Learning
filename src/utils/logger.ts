import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logDir = process.env.LOG_FILE_PATH || './logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

/**
 * Custom log format for structured logging
 */
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const logObject = {
      timestamp,
      level,
      message,
      ...(stack && { stack }),
      ...(Object.keys(meta).length > 0 && { meta })
    };
    return JSON.stringify(logObject);
  })
);

/**
 * Console format for development
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return `${timestamp} [${level}]: ${message}${stack ? '\n' + stack : ''}`;
  })
);

/**
 * Create Winston logger instance
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { 
    service: 'english-learning-api',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  },
  transports: [
    // Error logs
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    
    // Combined logs
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    
    // Console output
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production' ? logFormat : consoleFormat,
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
    })
  ],
  
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logDir, 'exceptions.log'),
      maxsize: 5242880,
      maxFiles: 3,
    })
  ],
  
  // Handle unhandled promise rejections
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logDir, 'rejections.log'),
      maxsize: 5242880,
      maxFiles: 3,
    })
  ]
});

/**
 * Create child logger with additional context
 */
export const createChildLogger = (context: Record<string, any>) => {
  return logger.child(context);
};

/**
 * Log request information
 */
export const logRequest = (req: any, res: any, responseTime?: number) => {
  const logData = {
    method: req.method,
    url: req.originalUrl,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    statusCode: res.statusCode,
    ...(responseTime && { responseTime: `${responseTime}ms` }),
    ...(req.id && { requestId: req.id })
  };
  
  if (res.statusCode >= 400) {
    logger.warn('HTTP Request', logData);
  } else {
    logger.info('HTTP Request', logData);
  }
};

/**
 * Log user action
 */
export const logUserAction = (userId: string, action: string, metadata?: Record<string, any>) => {
  logger.info('User Action', {
    userId,
    action,
    ...metadata
  });
};

/**
 * Log external API call
 */
export const logApiCall = (service: string, endpoint: string, duration: number, success: boolean, error?: string) => {
  const logData = {
    service,
    endpoint,
    duration: `${duration}ms`,
    success
  };
  
  if (success) {
    logger.info('External API Call', logData);
  } else {
    logger.error('External API Call Failed', { ...logData, error });
  }
};

// Initialize logger
if (process.env.NODE_ENV !== 'test') {
  logger.info('Logger initialized', {
    level: logger.level,
    environment: process.env.NODE_ENV
  });
}