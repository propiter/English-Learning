import axios from 'axios';
import crypto from 'crypto';
import { logger, logUserAction, logApiCall } from '../../utils/logger.js';
import { MessagePayload } from '../../types/index.js';
import { orchestratorService } from '../orchestrator/service.js';
import { userService } from '../users/service.js';
import { createError } from '../../middleware/errorHandler.js';
import { validateRequestBody, telegramWebhookSchema, whatsappWebhookSchema } from '../../utils/validation.js';
import env from '../../config/environment.js';

/**
 * Messaging gateway service for handling platform communications
 */
export class MessagingGatewayService {
  private readonly telegramToken = env.TELEGRAM_BOT_TOKEN;
  private readonly telegramApiUrl = `https://api.telegram.org/bot${this.telegramToken}`;
  private readonly whatsappApiUrl = env.WHATSAPP_API_URL;
  private readonly whatsappToken = env.WHATSAPP_ACCESS_TOKEN;

  /**
   * Send message to user on specified platform
   */
  async sendMessage(userId: string, platform: 'telegram' | 'whatsapp', audioUrl?: string, text?: string) {
    const startTime = Date.now();
    
    try {
      if (!audioUrl && !text) {
        throw createError('Either audioUrl or text must be provided', 400);
      }

      let result;
      if (platform === 'telegram') {
        result = await this._sendTelegramMessage(userId, audioUrl, text);
      } else if (platform === 'whatsapp') {
        result = await this._sendWhatsAppMessage(userId, audioUrl, text);
      } else {
        throw createError(`Unsupported platform: ${platform}`, 400);
      }

      logApiCall(`${platform}-api`, 'send-message', Date.now() - startTime, true);
      logUserAction(userId, 'message_sent', { platform, hasAudio: !!audioUrl, hasText: !!text });
      
      return result;
    } catch (error) {
      logApiCall(`${platform}-api`, 'send-message', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
      logger.error(`Error sending message to ${platform}:`, { userId, error });
      throw error;
    }
  }

  /**
   * Send message via Telegram
   */
  private async _sendTelegramMessage(chatId: string, audioUrl?: string, text?: string) {
    const messages = [];

    try {
      // Send audio first if available
      if (audioUrl) {
        const audioResponse = await axios.post(`${this.telegramApiUrl}/sendVoice`, {
          chat_id: chatId,
          voice: audioUrl,
          caption: "🎧 Here's your personalized feedback!"
        }, {
          timeout: env.TELEGRAM_API_TIMEOUT
        });
        messages.push(audioResponse.data);
      }

      // Send text summary
      if (text) {
        const textResponse = await axios.post(`${this.telegramApiUrl}/sendMessage`, {
          chat_id: chatId,
          text: `📊 ${text}`,
          parse_mode: 'HTML'
        }, {
          timeout: env.TELEGRAM_API_TIMEOUT
        });
        messages.push(textResponse.data);
      }

      return messages;
    } catch (error) {
      logger.error('Error sending Telegram message:', { chatId, error });
      throw createError('Failed to send Telegram message', 500);
    }
  }

  /**
   * Send message via WhatsApp
   */
  private async _sendWhatsAppMessage(phoneNumber: string, audioUrl?: string, text?: string) {
    const messages = [];

    try {
      // Send audio first if available
      if (audioUrl) {
        const audioResponse = await axios.post(`${this.whatsappApiUrl}/messages`, {
          messaging_product: "whatsapp",
          to: phoneNumber,
          type: "audio",
          audio: {
            link: audioUrl
          }
        }, {
          headers: {
            'Authorization': `Bearer ${this.whatsappToken}`,
            'Content-Type': 'application/json'
          },
          timeout: env.WHATSAPP_API_TIMEOUT
        });
        messages.push(audioResponse.data);
      }

      // Send text summary
      if (text) {
        const textResponse = await axios.post(`${this.whatsappApiUrl}/messages`, {
          messaging_product: "whatsapp",
          to: phoneNumber,
          type: "text",
          text: {
            body: text
          }
        }, {
          headers: {
            'Authorization': `Bearer ${this.whatsappToken}`,
            'Content-Type': 'application/json'
          },
          timeout: env.WHATSAPP_API_TIMEOUT
        });
        messages.push(textResponse.data);
      }

      return messages;
    } catch (error) {
      logger.error('Error sending WhatsApp message:', { phoneNumber, error });
      throw createError('Failed to send WhatsApp message', 500);
    }
  }

  /**
   * Process incoming webhook from messaging platforms
   */
  async processIncomingWebhook(platform: 'telegram' | 'whatsapp', webhookData: any, signature?: string) {
    const startTime = Date.now();
    
    try {
      // Validate webhook data structure
      this._validateWebhookData(platform, webhookData);

      // Verify webhook signature in production
      if (process.env.NODE_ENV === 'production' && signature) {
        this._verifyWebhookSignature(platform, webhookData, signature);
      }

      // Extract message data
      const messageData = this._extractMessageData(platform, webhookData);
      
      if (messageData) {
        // Ensure user exists and process message
        await this._processMessage(messageData);
        
        logApiCall(`${platform}-webhook`, 'process', Date.now() - startTime, true);
        return { success: true, processed: true };
      }

      logApiCall(`${platform}-webhook`, 'process', Date.now() - startTime, true);
      return { success: true, processed: false, reason: 'No message data found' };

    } catch (error) {
      logApiCall(`${platform}-webhook`, 'process', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
      logger.error('Error processing webhook:', { platform, error });
      throw error;
    }
  }

  /**
   * Validate webhook data structure
   */
  private _validateWebhookData(platform: 'telegram' | 'whatsapp', webhookData: any) {
    try {
      if (platform === 'telegram') {
        validateRequestBody(telegramWebhookSchema)(webhookData);
      } else {
        validateRequestBody(whatsappWebhookSchema)(webhookData);
      }
    } catch (error) {
      logger.warn('Invalid webhook data structure:', { platform, error });
      throw createError('Invalid webhook data structure', 400);
    }
  }

  /**
   * Verify webhook signature
   */
  private _verifyWebhookSignature(platform: 'telegram' | 'whatsapp', webhookData: any, signature: string) {
    let isValid = false;
    
    if (platform === 'telegram') {
      const expectedSignature = crypto
        .createHmac('sha256', this.telegramToken)
        .update(JSON.stringify(webhookData))
        .digest('hex');
      isValid = signature === expectedSignature;
    } else {
      const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', env.WHATSAPP_VERIFY_TOKEN)
        .update(JSON.stringify(webhookData))
        .digest('hex');
      isValid = signature === expectedSignature;
    }
    
    if (!isValid) {
      logger.warn(`Invalid webhook signature for ${platform}`, { 
        provided: signature.substring(0, 10) + '...',
        platform 
      });
      throw createError('Invalid webhook signature', 401);
    }
  }

  /**
   * Extract message data from webhook
   */
  private _extractMessageData(platform: 'telegram' | 'whatsapp', webhookData: any): MessagePayload | null {
    if (platform === 'telegram') {
      return this._processTelegramWebhook(webhookData);
    } else {
      return this._processWhatsAppWebhook(webhookData);
    }
  }

  /**
   * Process Telegram webhook data
   */
  private _processTelegramWebhook(webhookData: any): MessagePayload | null {
    const message = webhookData.message;
    if (!message) return null;

    const chatId = message.chat.id.toString();
    const userId = message.from?.id?.toString();

    if (!userId) {
      logger.warn('Telegram webhook missing user ID');
      return null;
    }

    // Handle voice messages
    if (message.voice) {
      return {
        userId,
        platform: 'telegram' as const,
        messageType: 'audio' as const,
        content: message.voice.file_id,
        chatId,
        userData: {
          firstName: message.from.first_name,
          lastName: message.from.last_name,
          username: message.from.username
        }
      };
    }

    // Handle text messages
    if (message.text) {
      return {
        userId,
        platform: 'telegram' as const,
        messageType: 'text' as const,
        content: message.text,
        chatId,
        userData: {
          firstName: message.from.first_name,
          lastName: message.from.last_name,
          username: message.from.username
        }
      };
    }

    return null;
  }

  /**
   * Process WhatsApp webhook data
   */
  private _processWhatsAppWebhook(webhookData: any): MessagePayload | null {
    const entry = webhookData.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return null;

    const message = messages[0];
    const from = message.from;

    if (!from) {
      logger.warn('WhatsApp webhook missing sender ID');
      return null;
    }

    // Handle audio messages
    if (message.type === 'audio') {
      return {
        userId: from,
        platform: 'whatsapp' as const,
        messageType: 'audio' as const,
        content: message.audio.id,
        chatId: from,
        userData: {
          firstName: value.contacts?.[0]?.profile?.name || 'User'
        }
      };
    }

    // Handle text messages
    if (message.type === 'text') {
      return {
        userId: from,
        platform: 'whatsapp' as const,
        messageType: 'text' as const,
        content: message.text.body,
        chatId: from,
        userData: {
          firstName: value.contacts?.[0]?.profile?.name || 'User'
        }
      };
    }

    return null;
  }

  /**
   * Process extracted message data
   */
  private async _processMessage(messageData: MessagePayload) {
    try {
      // Ensure user exists
      await this._ensureUserExists(messageData);
      
      // Forward to orchestrator for processing
      await orchestratorService.handleUserMessage(
        messageData.userId,
        messageData.content,
        messageData.platform,
        messageData
      );

      logUserAction(messageData.userId, 'message_processed', { 
        platform: messageData.platform,
        messageType: messageData.messageType 
      });

    } catch (error) {
      logger.error('Error processing message:', { 
        userId: messageData.userId,
        platform: messageData.platform,
        error 
      });
      throw error;
    }
  }

  /**
   * Ensure user exists in database
   */
  private async _ensureUserExists(messageData: MessagePayload) {
    try {
      // Check if user exists
      const existingUser = await userService.getUserByPlatformId(
        messageData.platform,
        messageData.userId
      );

      if (!existingUser) {
        // Create new user
        const userData = {
          [messageData.platform === 'telegram' ? 'telegramId' : 'whatsappId']: messageData.userId,
          firstName: messageData.userData?.firstName || 'User',
          lastName: messageData.userData?.lastName || '',
          username: messageData.userData?.username || `user_${Date.now()}`,
          language: 'es', // Default to Spanish
          timezone: 'UTC'
        };

        const newUser = await userService.createUser(userData);
        
        logUserAction(newUser.id, 'user_created', { 
          platform: messageData.platform,
          source: 'webhook' 
        });
        
        logger.info(`Created new user: ${newUser.id} for ${messageData.platform}`);
      }
    } catch (error) {
      logger.error('Error ensuring user exists:', { 
        userId: messageData.userId,
        platform: messageData.platform,
        error 
      });
      throw createError('Failed to ensure user exists', 500);
    }
  }

  /**
   * Download audio file from Telegram
   */
  async downloadTelegramAudio(fileId: string): Promise<Buffer> {
    try {
      // Get file info
      const fileInfoResponse = await axios.get(`${this.telegramApiUrl}/getFile`, {
        params: { file_id: fileId },
        timeout: env.TELEGRAM_API_TIMEOUT
      });

      const filePath = fileInfoResponse.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${this.telegramToken}/${filePath}`;

      // Download file
      const fileResponse = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: env.TELEGRAM_API_TIMEOUT
      });

      return Buffer.from(fileResponse.data);
    } catch (error) {
      logger.error('Error downloading Telegram audio:', { fileId, error });
      throw createError('Failed to download audio file', 500);
    }
  }

  /**
   * Download audio file from WhatsApp
   */
  async downloadWhatsAppAudio(mediaId: string): Promise<Buffer> {
    try {
      // Get media URL
      const mediaInfoResponse = await axios.get(`${this.whatsappApiUrl}/${mediaId}`, {
        headers: {
          'Authorization': `Bearer ${this.whatsappToken}`
        },
        timeout: env.WHATSAPP_API_TIMEOUT
      });

      const mediaUrl = mediaInfoResponse.data.url;

      // Download file
      const fileResponse = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${this.whatsappToken}`
        },
        responseType: 'arraybuffer',
        timeout: env.WHATSAPP_API_TIMEOUT
      });

      return Buffer.from(fileResponse.data);
    } catch (error) {
      logger.error('Error downloading WhatsApp audio:', { mediaId, error });
      throw createError('Failed to download audio file', 500);
    }
  }
}

export const messagingGatewayService = new MessagingGatewayService();