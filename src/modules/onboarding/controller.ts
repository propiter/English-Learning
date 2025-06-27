import { Request, Response } from 'express';
import { onboardingService } from './service.js';
import { asyncHandler, createError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import redisManager from '../../config/redis.js';

export const onboardingController = {
  // Process onboarding step
  processStep: asyncHandler(async (req: Request, res: Response) => {
    const { userId, input, currentStep, platform } = req.body;

    if (!userId || !input || !currentStep || !platform) {
      throw createError('Missing required fields: userId, input, currentStep, platform', 400);
    }

    logger.info(`Processing onboarding step: ${currentStep} for user: ${userId}`);

    const result = await onboardingService.processOnboardingStep(userId, input, currentStep, platform);

    res.json({
      success: true,
      data: result
    });
  }),

  // Get onboarding status
  getStatus: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;

    // This would fetch current onboarding state
    // For now, return a simple response
    res.json({
      success: true,
      data: {
        userId,
        message: 'Onboarding status retrieved'
      }
    });
  }),

  // Test Redis connection and onboarding state
  testRedis: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.body;
    
    if (!userId) {
      throw createError('User ID is required', 400);
    }

    // Test Redis connection
    const health = await redisManager.checkHealth();
    
    // Test onboarding state operations
    const testState = {
      step: 'test',
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Save test state
    await redisManager.setJSON(`onboarding:${userId}`, testState, 300); // 5 min TTL
    
    // Retrieve test state
    const retrievedState = await redisManager.getJSON(`onboarding:${userId}`);
    
    // Clear test state
    await redisManager.del(`onboarding:${userId}`);
    
    res.json({
      success: true,
      data: {
        redisHealth: health,
        savedState: testState,
        retrievedState,
        stateMatches: JSON.stringify(testState) === JSON.stringify(retrievedState)
      }
    });
  })
};