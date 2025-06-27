import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { ZodError } from 'zod';

/**
 * Custom application error class
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly context?: Record<string, any>;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    context?: Record<string, any>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.context = context;
    
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Create a new application error
 */
export const createError = (
  message: string,
  statusCode: number = 500,
  context?: Record<string, any>
): AppError => {
  return new AppError(message, statusCode, true, context);
};

/**
 * Async handler wrapper to catch async errors
 */
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Handle different types of errors
 */
const handleCastErrorDB = (err: any): AppError => {
  const message = `Invalid ${err.path}: ${err.value}`;
  return new AppError(message, 400);
};

const handleDuplicateFieldsDB = (err: any): AppError => {
  const value = err.errmsg?.match(/(["'])(\\?.)*?\1/)?.[0];
  const message = `Duplicate field value: ${value}. Please use another value!`;
  return new AppError(message, 400);
};

const handleValidationErrorDB = (err: any): AppError => {
  const errors = Object.values(err.errors).map((el: any) => el.message);
  const message = `Invalid input data. ${errors.join('. ')}`;
  return new AppError(message, 400);
};

const handleJWTError = (): AppError =>
  new AppError('Invalid token. Please log in again!', 401);

const handleJWTExpiredError = (): AppError =>
  new AppError('Your token has expired! Please log in again.', 401);

const handleZodError = (err: ZodError): AppError => {
  const errors = err.errors.map(error => `${error.path.join('.')}: ${error.message}`);
  const message = `Validation failed: ${errors.join(', ')}`;
  return new AppError(message, 400);
};

/**
 * Send error response in development
 */
const sendErrorDev = (err: AppError, req: Request, res: Response) => {
  logger.error('Error in development:', {
    error: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    body: req.body,
    params: req.params,
    query: req.query,
    headers: req.headers,
    context: err.context
  });

  res.status(err.statusCode).json({
    success: false,
    error: {
      message: err.message,
      stack: err.stack,
      context: err.context
    },
    request: {
      url: req.originalUrl,
      method: req.method,
      timestamp: new Date().toISOString()
    }
  });
};

/**
 * Send error response in production
 */
const sendErrorProd = (err: AppError, req: Request, res: Response) => {
  // Log error details for monitoring
  logger.error('Production error:', {
    message: err.message,
    statusCode: err.statusCode,
    isOperational: err.isOperational,
    url: req.originalUrl,
    method: req.method,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    context: err.context,
    ...(req.id && { requestId: req.id })
  });

  // Operational, trusted error: send message to client
  if (err.isOperational) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        message: err.message
      }
    });
  } else {
    // Programming or other unknown error: don't leak error details
    res.status(500).json({
      success: false,
      error: {
        message: 'Something went wrong! Please try again later.'
      }
    });
  }
};

/**
 * Global error handling middleware
 */
export const errorHandler = (
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let err = { ...error };
  err.message = error.message;

  // Mongoose bad ObjectId
  if (error.name === 'CastError') err = handleCastErrorDB(err);

  // Mongoose duplicate key
  if (error.code === 11000) err = handleDuplicateFieldsDB(err);

  // Mongoose validation error
  if (error.name === 'ValidationError') err = handleValidationErrorDB(err);

  // JWT errors
  if (error.name === 'JsonWebTokenError') err = handleJWTError();
  if (error.name === 'TokenExpiredError') err = handleJWTExpiredError();

  // Zod validation errors
  if (error instanceof ZodError) err = handleZodError(error);

  // Prisma errors
  if (error.name === 'PrismaClientKnownRequestError') {
    if (error.code === 'P2002') {
      err = new AppError('Duplicate field value. Please use another value!', 400);
    } else if (error.code === 'P2025') {
      err = new AppError('Record not found', 404);
    } else {
      err = new AppError('Database operation failed', 400);
    }
  }

  // Ensure err is an AppError instance
  if (!(err instanceof AppError)) {
    err = new AppError(err.message || 'Something went wrong!', err.statusCode || 500);
  }

  if (process.env.NODE_ENV === 'development') {
    sendErrorDev(err, req, res);
  } else {
    sendErrorProd(err, req, res);
  }
};

/**
 * Handle 404 errors
 */
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  const err = new AppError(`Route ${req.originalUrl} not found`, 404);
  next(err);
};

/**
 * Handle uncaught exceptions
 */
process.on('uncaughtException', (err: Error) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Shutting down...', {
    error: err.message,
    stack: err.stack
  });
  process.exit(1);
});

/**
 * Handle unhandled promise rejections
 */
process.on('unhandledRejection', (err: any) => {
  logger.error('UNHANDLED REJECTION! 💥 Shutting down...', {
    error: err.message,
    stack: err.stack
  });
  process.exit(1);
});