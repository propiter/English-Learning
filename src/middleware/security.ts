import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import env from '../config/environment.js';

/**
 * Verify Telegram webhook signature
 */
export const verifyTelegramWebhook = (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-telegram-bot-api-secret-token'] as string;
    
    if (!signature) {
      logger.warn('Missing Telegram webhook signature');
      return res.status(401).json({
        success: false,
        error: { message: 'Missing webhook signature' }
      });
    }

    const expectedSignature = crypto
      .createHmac('sha256', env.TELEGRAM_BOT_TOKEN)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (signature !== expectedSignature) {
      logger.warn('Invalid Telegram webhook signature', {
        provided: signature,
        expected: expectedSignature
      });
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid webhook signature' }
      });
    }

    next();
  } catch (error) {
    logger.error('Error verifying Telegram webhook:', error);
    return res.status(500).json({
      success: false,
      error: { message: 'Webhook verification failed' }
    });
  }
};

/**
 * Verify WhatsApp webhook signature
 */
export const verifyWhatsAppWebhook = (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string;
    
    if (!signature) {
      logger.warn('Missing WhatsApp webhook signature');
      return res.status(401).json({
        success: false,
        error: { message: 'Missing webhook signature' }
      });
    }

    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', env.WHATSAPP_VERIFY_TOKEN)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (signature !== expectedSignature) {
      logger.warn('Invalid WhatsApp webhook signature', {
        provided: signature,
        expected: expectedSignature
      });
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid webhook signature' }
      });
    }

    next();
  } catch (error) {
    logger.error('Error verifying WhatsApp webhook:', error);
    return res.status(500).json({
      success: false,
      error: { message: 'Webhook verification failed' }
    });
  }
};

/**
 * Sanitize request body to prevent injection attacks
 */
export const sanitizeBody = (req: Request, res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }
  next();
};

/**
 * Recursively sanitize object properties
 */
function sanitizeObject(obj: any): void {
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      if (typeof obj[key] === 'string') {
        obj[key] = sanitizeString(obj[key]);
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        sanitizeObject(obj[key]);
      }
    }
  }
}

/**
 * Sanitize string to prevent XSS and injection attacks
 */
function sanitizeString(str: string): string {
  return str
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers
    .replace(/script/gi, '') // Remove script tags
    .trim();
}

/**
 * Add security headers
 */
export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Content Security Policy
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  
  next();
};

/**
 * Request ID middleware for tracing
 */
export const requestId = (req: Request, res: Response, next: NextFunction) => {
  const id = crypto.randomBytes(16).toString('hex');
  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
};

/**
 * Validate content type for API endpoints
 */
export const validateContentType = (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const contentType = req.headers['content-type'];
    
    if (!contentType || !contentType.includes('application/json')) {
      return res.status(400).json({
        success: false,
        error: { message: 'Content-Type must be application/json' }
      });
    }
  }
  
  next();
};