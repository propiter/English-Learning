import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { MessagePayload } from '../../types/index.js';

export class MessagingGatewayService {
  private readonly telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly telegramApiUrl = `https://api.telegram.org/bot${this.telegramToken}`;
  private readonly whatsappApiUrl = process.env.WHATSAPP_API_URL;
  private readonly whatsappToken = process.env.WHATSAPP_ACCESS_TOKEN;

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

  async processIncomingWebhook(platform: 'telegram' | 'whatsapp', webhookData: any) {
    try {
      let messageData = null;

      if (platform === 'telegram') {
        messageData = this.processTelegramWebhook(webhookData);
      } else {
        messageData = this.processWhatsAppWebhook(webhookData);
      }

      if (messageData) {
        // Forward to orchestrator for processing
        await this.forwardToOrchestrator(messageData);
      }

      return { success: true, processed: !!messageData };
    } catch (error) {
      logger.error('Error processing webhook:', error);
      throw error;
    }
  }

  private processTelegramWebhook(webhookData: any) {
    const message = webhookData.message;
    if (!message) return null;

    const chatId = message.chat.id.toString();
    const userId = message.from?.id?.toString();

    // Handle voice messages
    if (message.voice) {
      return {
        userId,
        platform: 'telegram' as const,
        messageType: 'audio' as const,
        content: message.voice.file_id, // Telegram file_id
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

  private processWhatsAppWebhook(webhookData: any) {
    const entry = webhookData.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return null;

    const message = messages[0];
    const from = message.from;

    // Handle audio messages
    if (message.type === 'audio') {
      return {
        userId: from,
        platform: 'whatsapp' as const,
        messageType: 'audio' as const,
        content: message.audio.id, // WhatsApp media ID
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

  private async forwardToOrchestrator(messageData: any) {
    try {
      const baseURL = process.env.API_BASE_URL || 'http://localhost:3000';
      
      // First, ensure user exists
      await this.ensureUserExists(messageData);

      // Then process the message
      await axios.post(`${baseURL}/api/orchestrator/process-message`, {
        userId: messageData.userId,
        audioInput: messageData.content,
        platform: messageData.platform
      }, {
        headers: {
          'x-api-key': process.env.INTERNAL_API_KEY
        }
      });

    } catch (error) {
      logger.error('Error forwarding to orchestrator:', error);
      throw error;
    }
  }

  private async ensureUserExists(messageData: any) {
    try {
      const baseURL = process.env.API_BASE_URL || 'http://localhost:3000';
      
      // Check if user exists
      const checkResponse = await axios.get(
        `${baseURL}/api/users/platform/${messageData.platform}/${messageData.userId}`,
        {
          headers: { 'x-api-key': process.env.INTERNAL_API_KEY }
        }
      );

      if (!checkResponse.data.data.exists) {
        // Create new user
        const userData: any = {
          firstName: messageData.userData.firstName,
          lastName: messageData.userData.lastName,
          username: messageData.userData.username
        };

        if (messageData.platform === 'telegram') {
          userData.telegramId = messageData.userId;
        } else {
          userData.whatsappId = messageData.userId;
        }

        await axios.post(`${baseURL}/api/users/register`, userData);
        logger.info(`New user registered: ${messageData.userId} on ${messageData.platform}`);
      }
    } catch (error) {
      logger.error('Error ensuring user exists:', error);
      throw error;
    }
  }
}

export const messagingGatewayService = new MessagingGatewayService();