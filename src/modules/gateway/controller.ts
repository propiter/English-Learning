import { Request, Response } from 'express';
import { messagingGatewayService } from './service.js';
import { asyncHandler, createError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import prisma from '../../config/database.js';
import { userService } from '../users/service.js';

export const gatewayController = {
  // Telegram webhook endpoint
  telegramWebhook: asyncHandler(async (req: Request, res: Response) => {
    const webhookData = req.body;
    
    // Log incoming webhook for debugging
    await prisma.webhookLog.create({
      data: {
        platform: 'telegram',
        webhookData,
        processed: false
      }
    });

    logger.info('Received Telegram webhook:', JSON.stringify(webhookData, null, 2));

    try {
      const result = await messagingGatewayService.processIncomingWebhook('telegram', webhookData);
      
      // Update webhook log
      await prisma.webhookLog.updateMany({
        where: {
          platform: 'telegram',
          processed: false,
          webhookData: {
            equals: webhookData
          }
        },
        data: {
          processed: true
        }
      });

      res.json({ success: true, processed: result.processed });
    } catch (error) {
      logger.error('Error processing Telegram webhook:', error);
      
      // Update webhook log with error
      await prisma.webhookLog.updateMany({
        where: {
          platform: 'telegram',
          processed: false,
          webhookData: {
            equals: webhookData
          }
        },
        data: {
          processed: true,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      });

      throw error;
    }
  }),

  // WhatsApp webhook endpoint
  whatsappWebhook: asyncHandler(async (req: Request, res: Response) => {
    const webhookData = req.body;

    // Log incoming webhook
    await prisma.webhookLog.create({
      data: {
        platform: 'whatsapp',
        webhookData,
        processed: false
      }
    });

    logger.info('Received WhatsApp webhook:', JSON.stringify(webhookData, null, 2));

    try {
      const result = await messagingGatewayService.processIncomingWebhook('whatsapp', webhookData);
      
      // Update webhook log
      await prisma.webhookLog.updateMany({
        where: {
          platform: 'whatsapp',
          processed: false,
          webhookData: {
            equals: webhookData
          }
        },
        data: {
          processed: true
        }
      });

      res.json({ success: true, processed: result.processed });
    } catch (error) {
      logger.error('Error processing WhatsApp webhook:', error);
      
      // Update webhook log with error
      await prisma.webhookLog.updateMany({
        where: {
          platform: 'whatsapp',
          processed: false,
          webhookData: {
            equals: webhookData
          }
        },
        data: {
          processed: true,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      });

      throw error;
    }
  }),

  // WhatsApp webhook verification
  whatsappWebhookVerification: (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      logger.info('WhatsApp webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      res.status(403).send('Verification failed');
    }
  },

  // Web chat webhook endpoint
  webChatWebhook: asyncHandler(async (req: Request, res: Response) => {
    const webhookData = req.body;
    
    logger.info('Received Web Chat webhook:', {
      chatId: webhookData?.chat?.id,
      username: webhookData?.chat?.username,
      hasText: !!webhookData?.chat?.message?.text,
      hasFile: !!webhookData?.chat?.message?.file
    });
    
    // Log incoming webhook for debugging
    await prisma.webhookLog.create({
      data: {
        platform: 'webchat',
        webhookData,
        processed: false
      }
    });

    try {
      const result = await messagingGatewayService.processIncomingWebhook('web', webhookData);
      
      // Update webhook log
      await prisma.webhookLog.updateMany({
        where: {
          platform: 'webchat',
          processed: false,
          webhookData: {
            equals: webhookData
          }
        },
        data: {
          processed: true
        }
      });

      logger.info('Web Chat webhook processed successfully', {
        chatId: webhookData?.chat?.id,
        processed: result.processed
      });

      res.json({ success: true, processed: result.processed });
    } catch (error) {
      logger.error('Error processing Web Chat webhook:', error);
      
      // Update webhook log with error
      await prisma.webhookLog.updateMany({
        where: {
          platform: 'webchat',
          processed: false,
          webhookData: {
            equals: webhookData
          }
        },
        data: {
          processed: true,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      });

      throw error;
    }
  }),

  // Internal endpoint to send messages
  sendMessage: asyncHandler(async (req: Request, res: Response) => {
    const { userId, platform, audioUrl, text } = req.body;

    if (!userId || !platform) {
      throw createError('Missing required fields: userId, platform', 400);
    }

    if (!['telegram', 'whatsapp', 'web'].includes(platform)) {
      throw createError('Invalid platform', 400);
    }

    const result = await messagingGatewayService.sendMessage(userId, platform, audioUrl, text);

    res.json({
      success: true,
      data: { result }
    });
  }),

  // Get messages for web chat (polling)
  getWebChatMessages: asyncHandler(async (req: Request, res: Response) => {
    const { chatId } = req.params;
    const { since } = req.query;

    const messages = await messagingGatewayService.getWebChatMessages(
      chatId, 
      since?.toString()
    );

    res.json({
      success: true,
      data: { messages, chatId }
    });
  }),

  // Send message to web chat user
  sendWebChatMessage: asyncHandler(async (req: Request, res: Response) => {
    const { chatId } = req.params;
    const { text, audioUrl } = req.body;

    if (!text && !audioUrl) {
      throw createError('Either text or audioUrl must be provided', 400);
    }

    // Find user by webChatId
    const user = await userService.getUserByPlatformId('web', chatId);
    if (!user) {
      throw createError('User not found for this chat', 404);
    }

    const result = await messagingGatewayService.sendMessage(user.id, 'web', audioUrl, text);

    res.json({
      success: true,
      data: { result }
    });
  }),

  // Get webhook logs (for debugging)
  getWebhookLogs: asyncHandler(async (req: Request, res: Response) => {
    const { platform, processed } = req.query;
    const page = parseInt(req.query.page?.toString() || '1');
    const limit = parseInt(req.query.limit?.toString() || '50');
    const skip = (page - 1) * limit;

    const whereClause: any = {};
    if (platform) whereClause.platform = platform;
    if (processed !== undefined) whereClause.processed = processed === 'true';

    const [logs, total] = await Promise.all([
      prisma.webhookLog.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.webhookLog.count({ where: whereClause })
    ]);

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  })
};