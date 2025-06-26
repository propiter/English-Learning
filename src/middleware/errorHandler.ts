import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export const errorHandler = (
  error: AppError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let { statusCode = 500, message } = error;

  // Prisma specific errors
  if (error.name === 'PrismaClientKnownRequestError') {
    statusCode = 400;
    message = 'Database operation failed';
  }

  // Validation errors
  if (error.name === 'ValidationError') {
    statusCode = 400;
  }

  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  }

  logger.error(`Error ${statusCode}: ${message}`, {
    error: error.stack,
    url: req.url,
    method: req.method,
    body: req.body,
    params: req.params,
    query: req.query
  });

  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(statusCode).json({
    success: false,
    error: {
      message: isDevelopment ? message : (statusCode === 500 ? 'Internal server error' : message),
      ...(isDevelopment && { stack: error.stack })
    }
  });
};

export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export const createError = (message: string, statusCode: number = 500): AppError => {
  const error: AppError = new Error(message);
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
};