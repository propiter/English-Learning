import axios from 'axios';
import crypto from 'crypto';
import { logger, logUserAction, logApiCall } from '../../utils/logger.js';
import { MessagePayload, InputType } from '../../types/index.js';
import { orchestratorService } from '../orchestrator/service.js';
import { userService } from '../users/service.js';
import { createError } from '../../middleware/errorHandler.js';
import { validateRequestBody, telegramWebhookSchema, whatsappWebhookSchema } from '../../utils/validation.js';
import env from '../../config/environment.js';
import { onboardingService } from '../onboarding/service.js';

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

      const user = await userService.getUserById(userId);
      if (!user) {
        throw createError(`User not found for sending message: ${userId}`, 404);
      }

      const platformId = platform === 'telegram' ? user.telegramId : user.whatsappId;
      if (!platformId) {
        throw createError(`User ${userId} does not have a ${platform} ID.`, 400);
      }

      let result;
      if (platform === 'telegram') {
        result = await this._sendTelegramMessage(platformId, audioUrl, text);
      } else if (platform === 'whatsapp') {
        result = await this._sendWhatsAppMessage(platformId, audioUrl, text);
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

      if (text) {
        const textResponse = await axios.post(`${this.telegramApiUrl}/sendMessage`, {
          chat_id: chatId,
          text: text
          // FIX: Removed parse_mode to prevent 400 errors from malformed markdown in AI-generated text.
          // parse_mode: 'Markdown'
        }, {
          timeout: env.TELEGRAM_API_TIMEOUT
        });
        messages.push(textResponse.data);
      }

      return messages;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('Axios error sending Telegram message:', {
          chatId,
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
      } else {
        logger.error('Generic error sending Telegram message:', { chatId, error });
      }
      throw createError('Failed to send Telegram message', 500);
    }
  }

  /**
   * Send message via WhatsApp
   */
  private async _sendWhatsAppMessage(phoneNumber: string, audioUrl?: string, text?: string) {
    const messages = [];

    try {
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
      if (axios.isAxiosError(error)) {
        logger.error('Axios error sending WhatsApp message:', {
          phoneNumber,
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
      } else {
        logger.error('Generic error sending WhatsApp message:', { phoneNumber, error });
      }
      throw createError('Failed to send WhatsApp message', 500);
    }
  }

  /**
   * Process incoming webhook from messaging platforms
   */
  async processIncomingWebhook(platform: 'telegram' | 'whatsapp', webhookData: any, signature?: string) {
    const startTime = Date.now();
    
    try {
      this._validateWebhookData(platform, webhookData);

      if (process.env.NODE_ENV === 'production' && signature) {
        this._verifyWebhookSignature(platform, webhookData, signature);
      }

      const messageData = this._extractMessageData(platform, webhookData);
      
      if (messageData) {
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

  private _validateWebhookData(platform: 'telegram' | 'whatsapp', webhookData: any) {
    try {
      if (platform === 'telegram') {
        // Telegram can send an array of updates
        const dataToValidate = Array.isArray(webhookData) ? webhookData[0] : webhookData;
        validateRequestBody(telegramWebhookSchema)(dataToValidate);
      } else {
        validateRequestBody(whatsappWebhookSchema)(webhookData);
      }
    } catch (error) {
      logger.warn('Invalid webhook data structure:', { platform, error });
      throw createError('Invalid webhook data structure', 400);
    }
  }

  private _verifyWebhookSignature(platform: 'telegram' | 'whatsapp', webhookData: any, signature: string) {
    let isValid = false;
    const rawBody = JSON.stringify(webhookData);
    
    if (platform === 'telegram') {
      const secretToken = crypto.createHash('sha256').update(this.telegramToken).digest();
      const expectedSignature = crypto.createHmac('sha256', secretToken).update(rawBody).digest('hex');
      isValid = signature === expectedSignature;
    } else {
      const expectedSignature = 'sha256=' + crypto.createHmac('sha256', env.WHATSAPP_VERIFY_TOKEN).update(rawBody).digest('hex');
      isValid = signature === expectedSignature;
    }
    
    if (!isValid) {
      logger.warn(`Invalid webhook signature for ${platform}`, { provided: signature.substring(0, 10) + '...', platform });
      throw createError('Invalid webhook signature', 401);
    }
  }

  private _extractMessageData(platform: 'telegram' | 'whatsapp', webhookData: any): MessagePayload | null {
    if (platform === 'telegram') {
      const data = Array.isArray(webhookData) ? webhookData[0] : webhookData;
      return this._processTelegramWebhook(data);
    } else {
      return this._processWhatsAppWebhook(webhookData);
    }
  }

  private _processTelegramWebhook(webhookData: any): MessagePayload | null {
    const message = webhookData.message || webhookData.edited_message;
    if (!message) return null;

    const chatId = message.chat.id.toString();
    const platformId = message.from?.id?.toString();

    if (!platformId) {
      logger.warn('Telegram webhook missing user ID');
      return null;
    }

    let inputType: InputType | null = null;
    let content: string | null = null;

    if (message.voice) {
      inputType = 'audio';
      content = message.voice.file_id;
    } else if (message.text) {
      inputType = 'text';
      content = message.text;
    }

    if (!inputType || !content) {
      return null;
    }

    return {
      platformId,
      platform: 'telegram',
      inputType,
      content,
      chatId,
      rawData: webhookData,
      userData: {
        firstName: message.from.first_name,
        lastName: message.from.last_name,
        username: message.from.username
      }
    };
  }

  private _processWhatsAppWebhook(webhookData: any): MessagePayload | null {
    const message = webhookData.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const contact = webhookData.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
    if (!message || !contact) return null;

    const platformId = message.from;
    if (!platformId) {
      logger.warn('WhatsApp webhook missing sender ID');
      return null;
    }

    let inputType: InputType | null = null;
    let content: string | null = null;

    if (message.type === 'audio') {
      inputType = 'audio';
      content = message.audio.id;
    } else if (message.type === 'text') {
      inputType = 'text';
      content = message.text.body;
    }

    if (!inputType || !content) {
      return null;
    }

    return {
      platformId,
      platform: 'whatsapp',
      inputType,
      content,
      chatId: platformId,
      rawData: webhookData,
      userData: {
        firstName: contact.profile?.name || 'User'
      }
    };
  }

  private async _processMessage(messageData: MessagePayload) {
    try {
      const user = await this._ensureUserExists(messageData);
      
      // FIX: Correctly pass arguments to the orchestrator
      await orchestratorService.handleUserMessage(
        user.id,
        messageData.inputType,
        messageData.content,
        messageData.platform,
        messageData.rawData
      );

      logUserAction(user.id, 'message_processed', { 
        platform: messageData.platform,
        inputType: messageData.inputType 
      });

    } catch (error) {
      logger.error('Error processing message:', { 
        platformId: messageData.platformId,
        platform: messageData.platform,
        error 
      });
      throw error;
    }
  }

  private async _ensureUserExists(messageData: MessagePayload) {
    try {
      const existingUser = await userService.getUserByPlatformId(
        messageData.platform,
        messageData.platformId
      );

      if (existingUser) {
        return existingUser;
      }

      const userData = {
        [messageData.platform === 'telegram' ? 'telegramId' : 'whatsappId']: messageData.platformId,
        firstName: messageData.userData?.firstName || 'User',
        lastName: messageData.userData?.lastName || '',
        username: messageData.userData?.username || `user_${Date.now()}`,
        language: 'es',
        timezone: 'UTC'
      };

      const newUser = await userService.createUser(userData);
      
      logUserAction(newUser.id, 'user_created', { 
        platform: messageData.platform,
        source: 'webhook' 
      });
      
      logger.info(`Created new user: ${newUser.id} for ${messageData.platform}`);
      return newUser;

    } catch (error) {
      logger.error('Error ensuring user exists:', { 
        platformId: messageData.platformId,
        platform: messageData.platform,
        error 
      });
      throw createError('Failed to ensure user exists', 500);
    }
  }

  async downloadTelegramAudio(fileId: string): Promise<Buffer> {
    try {
      const fileInfoResponse = await axios.get(`${this.telegramApiUrl}/getFile`, {
        params: { file_id: fileId },
        timeout: env.TELEGRAM_API_TIMEOUT
      });

      const filePath = fileInfoResponse.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${this.telegramToken}/${filePath}`;

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

  async downloadWhatsAppAudio(mediaId: string): Promise<Buffer> {
    try {
      const mediaInfoResponse = await axios.get(`${this.whatsappApiUrl}/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${this.whatsappToken}` },
        timeout: env.WHATSAPP_API_TIMEOUT
      });

      const mediaUrl = mediaInfoResponse.data.url;

      const fileResponse = await axios.get(mediaUrl, {
        headers: { 'Authorization': `Bearer ${this.whatsappToken}` },
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
