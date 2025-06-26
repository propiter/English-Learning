import { Request, Response } from 'express';
import { contentService } from './service.js';
import { asyncHandler, createError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';

export const contentController = {
  // Get prompt by criteria
  getPrompt: asyncHandler(async (req: Request, res: Response) => {
    const { level, type, persona = 'alex' } = req.query;

    if (!level || !type) {
      throw createError('Missing required parameters: level, type', 400);
    }

    const prompt = await contentService.getPrompt(
      level.toString(),
      type.toString(),
      persona.toString()
    );

    res.json({
      success: true,
      data: { prompt }
    });
  }),

  // Get all prompts with filters
  getAllPrompts: asyncHandler(async (req: Request, res: Response) => {
    const filters = {
      cefrLevel: req.query.cefrLevel?.toString(),
      promptType: req.query.promptType?.toString(),
      persona: req.query.persona?.toString(),
      isActive: req.query.isActive === 'true'
    };

    // Remove undefined values
    Object.keys(filters).forEach(key => {
      if (filters[key as keyof typeof filters] === undefined) {
        delete filters[key as keyof typeof filters];
      }
    });

    const prompts = await contentService.getAllPrompts(filters);

    res.json({
      success: true,
      data: { prompts, count: prompts.length }
    });
  }),

  // Create new prompt
  createPrompt: asyncHandler(async (req: Request, res: Response) => {
    const { cefrLevel, promptType, persona, title, systemMessage, variables } = req.body;

    if (!cefrLevel || !promptType || !persona || !title || !systemMessage) {
      throw createError('Missing required fields', 400);
    }

    const prompt = await contentService.createPrompt({
      cefrLevel,
      promptType,
      persona,
      title,
      systemMessage,
      variables
    });

    res.status(201).json({
      success: true,
      data: { prompt }
    });
  }),

  // Update prompt
  updatePrompt: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const updateData = req.body;

    const prompt = await contentService.updatePrompt(id, updateData);

    res.json({
      success: true,
      data: { prompt }
    });
  }),

  // Delete prompt
  deletePrompt: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    await contentService.deletePrompt(id);

    res.json({
      success: true,
      message: 'Prompt deleted successfully'
    });
  }),

  // Get daily practice topic
  getDailyTopic: asyncHandler(async (req: Request, res: Response) => {
    const { level, interests } = req.query;

    if (!level) {
      throw createError('Missing required parameter: level', 400);
    }

    const interestsArray = interests ? interests.toString().split(',') : [];
    const topic = await contentService.getDailyPracticeTopic(level.toString(), interestsArray);

    res.json({
      success: true,
      data: { topic }
    });
  })
};