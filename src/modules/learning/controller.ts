import { Request, Response } from 'express';
import { learningService } from './service.js';
import { asyncHandler, createError } from '../../middleware/errorHandler.js';
import { sessionCreationSchema } from '../../utils/validation.js';
import { logger } from '../../utils/logger.js';

export const learningController = {
  // Create a new learning session
  createSession: asyncHandler(async (req: Request, res: Response) => {
    const { error, value } = sessionCreationSchema.validate(req.body);
    if (error) {
      throw createError(error.details[0].message, 400);
    }

    const session = await learningService.createSession(value);
    logger.info(`Session created for user: ${value.userId}`);

    res.status(201).json({
      success: true,
      data: { session }
    });
  }),

  // Get user's learning progress
  getProgress: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { timeframe = '30' } = req.query;

    const progress = await learningService.getUserProgress(userId, parseInt(timeframe.toString()));

    res.json({
      success: true,
      data: { progress }
    });
  }),

  // Get session history
  getSessionHistory: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { page = '1', limit = '20' } = req.query;

    const sessions = await learningService.getSessionHistory(
      userId, 
      parseInt(page.toString()), 
      parseInt(limit.toString())
    );

    res.json({
      success: true,
      data: sessions
    });
  }),

  // Get detailed session
  getSession: asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    const session = await learningService.getSessionById(sessionId);
    if (!session) {
      throw createError('Session not found', 404);
    }

    res.json({
      success: true,
      data: { session }
    });
  }),

  // Calculate XP for a session (internal use)
  calculateSessionXP: asyncHandler(async (req: Request, res: Response) => {
    const { overallScore, duration, sessionType, userLevel } = req.body;

    const xp = learningService.calculateXP(overallScore, duration, sessionType, userLevel);

    res.json({
      success: true,
      data: { xp }
    });
  }),

  // Check if user is eligible for level up
  checkLevelUpEligibility: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;

    const eligibility = await learningService.checkLevelUpEligibility(userId);

    res.json({
      success: true,
      data: { eligibility }
    });
  }),

  // Get learning analytics
  getAnalytics: asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;

    const analytics = await learningService.getLearningAnalytics(
      userId,
      startDate ? new Date(startDate.toString()) : undefined,
      endDate ? new Date(endDate.toString()) : undefined
    );

    res.json({
      success: true,
      data: { analytics }
    });
  })
};