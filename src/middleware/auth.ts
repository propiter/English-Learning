import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET!, (err: any, decoded: any) => {
    if (err) {
      logger.warn('Invalid token attempt:', err.message);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  });
};

export const generateToken = (userId: string, role: string = 'user'): string => {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );
};

// For internal API calls between modules (less strict)
export const authenticateInternal = (req: AuthRequest, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];
  
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  next();
};