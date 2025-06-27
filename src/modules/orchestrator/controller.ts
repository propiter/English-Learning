import { Request, Response } from 'express';
import { orchestratorService } from './service.js';
import { asyncHandler, createError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';

export const orchestratorController = {
  // Main entry point for processing user messages
  processMessage: asyncHandler(async (req: Request, res: Response) => {
    const { userId, platform, inputType, content, rawData } = req.body;

    if (!userId || !platform || !inputType || !content) {
      throw createError('Missing required fields: userId, platform, inputType, content', 400);
    }

    if (!['telegram', 'whatsapp'].includes(platform)) {
      throw createError('Invalid platform. Must be "telegram" or "whatsapp"', 400);
    }
    
    if (!['text', 'audio'].includes(inputType)) {
      throw createError('Invalid inputType. Must be "text" or "audio"', 400);
    }

    logger.info(`Processing ${inputType} message for user ${userId} on ${platform}`);

    const result = await orchestratorService.handleUserMessage(
      userId,
      inputType,
      content,
      platform,
      rawData
    );

    res.json({
      success: true,
      data: result
    });
  }),

  // Health check endpoint
  healthCheck: asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      message: 'Orchestrator service is healthy',
      timestamp: new Date().toISOString()
    });
  })
};
