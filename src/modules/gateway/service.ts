import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import { MessagePayload } from '../../types/index.js';
import { orchestratorService } from '../orchestrator/service.js';
import { userService } from '../users/service.js';

export class MessagingGatewayService {
  private readonly telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly telegramApiUrl = `https://api.telegram.org/bot${this.telegramToken}`;
  private readonly whatsappApiUrl = process.env.WHATSAPP_API_URL;
  private readonly whatsappToken = process.env.WHATSAPP_ACCESS_TOKEN;

  // Webhook signature verification
  private verifyTelegramWebhook(body: any, signature: string): boolean {
    if (!this.telegramToken) return false;
    
    const hash = crypto
      .createHmac('sha256', this.telegramToken)
      .update(JSON.stringify(body))
      .digest('hex');
    
    return hash === signature;
  }

  private verifyWhatsAppWebhook(body: any, signature: string): boolean {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!verifyToken) return false;
    
    const hash = crypto
      .createHmac('sha256', verifyToken)
      .update(JSON.stringify(body))
      .digest('hex');
    
    return `sha256=${hash}` === signature;
  }

  async sendMessage(userId: string, platform: 'telegram' | 'whatsapp', audioUrl?: string, text?: string) {
    try {
      if (platform === 'telegram') {
        return await this.sendTelegramMessage(userId, audioUrl, text);
      } else {
        return await this.sendWhatsAppMessage(userId, audioUrl, text);
      }
    } catch (error) {
      logger.error(`Error sending message to ${platform}:`, error);
      throw error;
    }
  }

  private async sendTelegramMessage(chatId: string, audioUrl?: string, text?: string) {
    try {
      const messages = [];

      // Send audio first if available
      if (audioUrl) {
        const audioResponse = await axios.post(`${this.telegramApiUrl}/sendVoice`, {
          chat_id: chatId,
          voice: audioUrl,
          caption: "🎧 Here's your personalized feedback!"
        });
        messages.push(audioResponse.data);
      }

      // Send text summary
      if (text) {
        const textResponse = await axios.post(`${this.telegramApiUrl}/sendMessage`, {
          chat_id: chatId,
          text: `📊 ${text}`,
          parse_mode: 'HTML'
        });
        messages.push(textResponse.data);
      }

      return messages;
    } catch (error) {
      logger.error('Error sending Telegram message:', error);
      throw error;
    }
  }

  private async sendWhatsAppMessage(phoneNumber: string, audioUrl?: string, text?: string) {
    try {
      const messages = [];

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
          }
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
          }
        });
        messages.push(textResponse.data);
      }

      return messages;
    } catch (error) {
      logger.error('Error sending WhatsApp message:', error);
      throw error;
    }
  }

  async processIncomingWebhook(platform: 'telegram' | 'whatsapp', webhookData: any, signature?: string) {
    try {
      // Verify webhook signature in production
      if (process.env.NODE_ENV === 'production' && signature) {
        const isValid = platform === 'telegram' 
          ? this.verifyTelegramWebhook(webhookData, signature)
          : this.verifyWhatsAppWebhook(webhookData, signature);
        
        if (!isValid) {
          logger.warn(`Invalid webhook signature for ${platform}`);
          return { success: false, processed: false, error: 'Invalid signature' };
        }
      }

      let messageData = null;

      if (platform === 'telegram') {
        messageData = this.processTelegramWebhook(webhookData);
      } else {
        messageData = this.processWhatsAppWebhook(webhookData);
      }

      if (messageData) {
        // Ensure user exists and forward to orchestrator
        await this.forwardToOrchestrator({
          ...messageData,
          rawData: webhookData
        });
      }

      return { success: true, processed: !!messageData };
    } catch (error) {
      logger.error('Error processing webhook:', error);
      throw error;
    }
  }

  private processTelegramWebhook(webhookData: any): MessagePayload | null {
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

  private processWhatsAppWebhook(webhookData: any): MessagePayload | null {
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

  private async forwardToOrchestrator(messageData: MessagePayload & { rawData: any }) {
    try {
      // Ensure user exists first
      await this.ensureUserExists(messageData);
      
      // Process the message directly using orchestratorService
      await orchestratorService.handleUserMessage(
        messageData.userId,
        messageData.content,
        messageData.platform,
        messageData.rawData
      );
    } catch (error) {
      logger.error('Error forwarding to orchestrator:', error);
      throw error;
    }
  }

  private async ensureUserExists(messageData: MessagePayload & { rawData: any }) {
    try {
      // Check if user exists by platform ID
      const existingUser = await userService.getUserByPlatformId(
        messageData.platform,
        messageData.userId
      );

      if (!existingUser) {
        // Create new user with proper data structure
        const userData = {
          [messageData.platform === 'telegram' ? 'telegramId' : 'whatsappId']: messageData.userId,
          firstName: messageData.userData?.firstName || 'User',
          lastName: messageData.userData?.lastName || '',
          username: messageData.userData?.username || `user_${Date.now()}`,
          language: 'es', // Default to Spanish
          timezone: 'UTC'
        };

        const newUser = await userService.createUser(userData);
        logger.info(`Created new user: ${newUser.id} for ${messageData.platform}`);
      }
    } catch (error) {
      logger.error('Error ensuring user exists:', error);
      throw error;
    }
  }
}

export const messagingGatewayService = new MessagingGatewayService();