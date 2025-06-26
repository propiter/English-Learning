import { Request, Response } from 'express';
import { userService } from './service.js';
import { asyncHandler, createError } from '../../middleware/errorHandler.js';
import { userRegistrationSchema, userUpdateSchema } from '../../utils/validation.js';
import { logger } from '../../utils/logger.js';

export const userController = {
  // Register new user (called when user starts conversation)
  register: asyncHandler(async (req: Request, res: Response) => {
    const { error, value } = userRegistrationSchema.validate(req.body);
    if (error) {
      throw createError(error.details[0].message, 400);
    }

    const user = await userService.createUser(value);
    logger.info(`New user registered: ${user.id}`);

    res.status(201).json({
      success: true,
      data: {
        user,
        isNewUser: true,
        onboardingRequired: true
      }
    });
  }),

  // Get user profile
  getProfile: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    
    const user = await userService.getUserById(id);
    if (!user) {
      throw createError('User not found', 404);
    }

    res.json({
      success: true,
      data: { user }
    });
  }),

  // Update user profile
  updateProfile: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { error, value } = userUpdateSchema.validate(req.body);
    
    if (error) {
      throw createError(error.details[0].message, 400);
    }

    const user = await userService.updateUser(id, value);
    
    res.json({
      success: true,
      data: { user }
    });
  }),

  // Find user by platform ID (internal use)
  findByPlatformId: asyncHandler(async (req: Request, res: Response) => {
    const { platform, platformId } = req.params;
    
    const user = await userService.getUserByPlatformId(platform as 'telegram' | 'whatsapp', platformId);
    
    res.json({
      success: true,
      data: { 
        user,
        exists: !!user 
      }
    });
  }),

  // Get user stats and progress
  getProgress: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    
    const progress = await userService.getUserProgress(id);
    
    res.json({
      success: true,
      data: { progress }
    });
  }),

  // Update user streak and XP (internal use)
  updateProgress: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { xpGained, sessionCompleted } = req.body;
    
    const result = await userService.updateUserProgress(id, xpGained, sessionCompleted);
    
    res.json({
      success: true,
      data: result
    });
  })
};