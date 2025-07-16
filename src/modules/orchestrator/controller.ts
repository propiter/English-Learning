import { Request, Response } from 'express';
import { orchestratorService } from './service.js';
import { asyncHandler, createError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { llmManager } from '../../config/llm.js';
import { speechToTextService } from '../../services/speechToText.js';
import { textToSpeechService } from '../../services/textToSpeech.js';

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
  }),

  // Get LLM provider status
  getLLMStatus: asyncHandler(async (req: Request, res: Response) => {
    const status = llmManager.getProviderStatus();
    const summary = llmManager.getConfigurationSummary();
    
    res.json({
      success: true,
      data: {
        summary,
        providers: status,
        recommendations: {
          fallbackEnabled: summary.fallbackEnabled,
          primaryProvider: summary.primaryProvider,
          status: summary.configuredProviders === 0 ? 'CRÍTICO' : 
                 summary.configuredProviders === 1 ? 'ADVERTENCIA' : 'ÓPTIMO',
          message: summary.configuredProviders === 0 ? 'No hay proveedores LLM configurados' :
                  summary.configuredProviders === 1 ? 'Solo un proveedor configurado - sin fallback' :
                  'Múltiples proveedores configurados - fallback habilitado'
        }
      }
    });
  }),

  // Get STT provider status
  getSTTStatus: asyncHandler(async (req: Request, res: Response) => {
    const status = speechToTextService.getProviderStatus();
    
    res.json({
      success: true,
      data: {
        providers: status,
        configured: status.filter(p => p.configured).length,
        total: status.length
      }
    });
  }),
  // Get TTS provider status
  getTTSStatus: asyncHandler(async (req: Request, res: Response) => {
    const status = textToSpeechService.getProviderStatus();
    
    res.json({
      success: true,
      data: {
        providers: status,
        configured: status.filter(p => p.configured).length,
        total: status.length,
        available: textToSpeechService.isAvailable()
      }
    });
  }),

  // Refrescar todos los proveedores (útil para cambios de configuración)
  refreshProviders: asyncHandler(async (req: Request, res: Response) => {
    logger.info('Refrescando todos los proveedores por solicitud manual...');
    
    try {
      await Promise.all([
        llmManager.refreshProviders(),
        speechToTextService.refreshProviders(),
        textToSpeechService.refreshProviders()
      ]);
      
      const llmSummary = llmManager.getConfigurationSummary();
      const sttStatus = speechToTextService.getProviderStatus();
      const ttsStatus = textToSpeechService.getProviderStatus();
      
      res.json({
        success: true,
        message: 'Proveedores refrescados exitosamente',
        data: {
          llm: llmSummary,
          stt: {
            configured: sttStatus.filter(p => p.configured).length,
            total: sttStatus.length
          },
          tts: {
            configured: ttsStatus.filter(p => p.configured).length,
            total: ttsStatus.length,
            available: textToSpeechService.isAvailable()
          }
        }
      });
    } catch (error) {
      logger.error('Error refrescando proveedores:', error);
      throw createError('Error al refrescar proveedores', 500);
    }
  })
};