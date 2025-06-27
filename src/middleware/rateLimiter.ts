import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import { logger } from '../utils/logger.js';
import env from '../config/environment.js';

/**
 * General API rate limiter
 */
export const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS, // 15 minutes
  max: env.RATE_LIMIT_MAX_REQUESTS, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: {
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000)
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      url: req.originalUrl,
      method: req.method
    });
    
    res.status(429).json({
      success: false,
      error: {
        message: 'Too many requests from this IP, please try again later.',
        retryAfter: Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000)
      }
    });
  }
});

/**
 * Webhook rate limiter (more permissive)
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per minute
  message: {
    success: false,
    error: {
      message: 'Webhook rate limit exceeded'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Webhook rate limit exceeded', {
      ip: req.ip,
      platform: req.path.includes('telegram') ? 'telegram' : 'whatsapp',
      url: req.originalUrl
    });
    
    res.status(429).json({
      success: false,
      error: {
        message: 'Webhook rate limit exceeded'
      }
    });
  }
});

/**
 * User-specific rate limiter for practice sessions
 */
export const userSessionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each user to 10 practice sessions per minute
  keyGenerator: (req) => {
    return req.body?.userId || req.params?.userId || req.ip;
  },
  message: {
    success: false,
    error: {
      message: 'Too many practice sessions. Please wait a moment before trying again.'
    }
  },
  handler: (req, res) => {
    const userId = req.body?.userId || req.params?.userId;
    logger.warn('User session rate limit exceeded', {
      userId,
      ip: req.ip,
      url: req.originalUrl
    });
    
    res.status(429).json({
      success: false,
      error: {
        message: 'Too many practice sessions. Please wait a moment before trying again.'
      }
    });
  }
});

/**
 * Speed limiter to slow down requests after threshold
 */
export const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50, // allow 50 requests per 15 minutes at full speed
  delayMs: (used, req) => {
    return (used - req.slowDown.limit) * 500;
  },
  maxDelayMs: 20000, // maximum delay of 20 seconds
  onSlowDown: (req, res, options) => {
    logger.warn('Speed limit reached', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      url: req.originalUrl,
      delay: options.delayMs
    });
  }
});

/**
 * Create user-specific rate limiter
 */
export const createUserRateLimiter = (windowMs: number, max: number) => {
  return rateLimit({
    windowMs,
    max,
    keyGenerator: (req) => {
      const userId = req.body?.userId || req.params?.userId;
      return userId ? `user:${userId}` : req.ip;
    },
    message: {
      success: false,
      error: {
        message: 'Rate limit exceeded for this user'
      }
    }
  });
};