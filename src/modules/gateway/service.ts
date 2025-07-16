import axios from 'axios';
import crypto from 'crypto';
import { logger, logUserAction, logApiCall } from '../../utils/logger.js';
import { MessagePayload, InputType } from '../../types/index.js';
import { orchestratorService } from '../orchestrator/service.js';
import { userService } from '../users/service.js';
import { createError } from '../../middleware/errorHandler.js';
import { validateRequestBody, telegramWebhookSchema, whatsappWebhookSchema, webChatWebhookSchema } from '../../utils/validation.js';
import env from '../../config/environment.js';
import { Buffer } from 'buffer';
import redisManager from '../../config/redis.js';
import { s3Client } from '../../config/s3.js';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';

/**
 * Messaging gateway service for handling platform communications
 */
export class MessagingGatewayService {
  private readonly telegramToken = env.TELEGRAM_BOT_TOKEN;
  private readonly telegramApiUrl = `https://api.telegram.org/bot${this.telegramToken}`;
  private readonly whatsappApiUrl = env.WHATSAPP_API_URL;
  private readonly whatsappToken = env.WHATSAPP_ACCESS_TOKEN;
  private readonly s3Bucket = env.AWS_S3_BUCKET;

  /**
   * Send message to user on specified platform
   */
  async sendMessage(userId: string, platform: 'telegram' | 'whatsapp' | 'web', audioUrl?: string, text?: string) {
    const startTime = Date.now();
    
    try {
      if (!audioUrl && !text) {
        throw createError('Either audioUrl or text must be provided', 400);
      }

      const user = await userService.getUserById(userId);
      if (!user) {
        throw createError(`User not found for sending message: ${userId}`, 404);
      }

      // Get platform ID based on platform
      const platformId = platform === 'telegram' ? user.telegramId : 
                        platform === 'whatsapp' ? user.whatsappId : 
                        user.webChatId;
      if (!platformId) {
        throw createError(`User ${userId} does not have a ${platform} ID.`, 400);
      }

      let result;
      if (platform === 'telegram') {
        result = await this._sendTelegramMessage(platformId, audioUrl, text);
      } else if (platform === 'whatsapp') {
        result = await this._sendWhatsAppMessage(platformId, audioUrl, text);
      } else if (platform === 'web') {
        result = await this._sendWebChatMessage(platformId, audioUrl, text);
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
        const payload = {
          chat_id: chatId,
          voice: audioUrl,
          caption: "🎧 Here's your personalized feedback!"
        };
        
        logger.info('Attempting to send Telegram voice message', {
          url: `${this.telegramApiUrl}/sendVoice`,
          payload
        });

        const audioResponse = await axios.post(`${this.telegramApiUrl}/sendVoice`, payload, {
          timeout: env.TELEGRAM_API_TIMEOUT
        });
        messages.push(audioResponse.data);
      }

      if (text) {
        const payload = {
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown'
        };

        logger.info('Attempting to send Telegram text message', {
          url: `${this.telegramApiUrl}/sendMessage`,
          payload
        });

        const textResponse = await axios.post(`${this.telegramApiUrl}/sendMessage`, payload, {
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
   * Send message via Web Chat
   */
  private async _sendWebChatMessage(chatId: string, audioUrl?: string, text?: string) {
    const response = {
      chatId,
      timestamp: new Date().toISOString(),
      messages: [] as any[]
    };

    if (audioUrl) {
      response.messages.push({
        type: 'audio',
        content: audioUrl,
        caption: "🎧 Here's your personalized feedback!"
      });
    }

    if (text) {
      response.messages.push({
        type: 'text',
        content: text
      });
    }

    // Store in Redis for frontend to retrieve
    const key = `webchat:response:${chatId}`;
    await redisManager.setJSON(key, response, 300); // 5 minutes TTL
    
    // Also store in a list for polling
    const listKey = `webchat:messages:${chatId}`;
    await redisManager.getClient().lpush(listKey, JSON.stringify(response));
    await redisManager.getClient().ltrim(listKey, 0, 49); // Keep last 50 messages
    await redisManager.getClient().expire(listKey, 3600); // 1 hour TTL

    logger.info('Web chat message queued for delivery', { chatId, hasAudio: !!audioUrl, hasText: !!text });
    
    return response;
  }

  /**
   * Process incoming webhook from messaging platforms
   */
  async processIncomingWebhook(platform: 'telegram' | 'whatsapp' | 'web', webhookData: any, signature?: string) {
    const startTime = Date.now();
    
    try {
      this._validateWebhookData(platform, webhookData);

      if (process.env.NODE_ENV === 'production' && signature && platform !== 'web') {
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

  private _validateWebhookData(platform: 'telegram' | 'whatsapp' | 'web', webhookData: any) {
    try {
      if (platform === 'telegram') {
        // Telegram can send an array of updates
        const dataToValidate = Array.isArray(webhookData) ? webhookData[0] : webhookData;
        validateRequestBody(telegramWebhookSchema)(dataToValidate);
      } else if (platform === 'whatsapp') {
        validateRequestBody(whatsappWebhookSchema)(webhookData);
      } else if (platform === 'web') {
        validateRequestBody(webChatWebhookSchema)(webhookData);
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

  private _extractMessageData(platform: 'telegram' | 'whatsapp' | 'web', webhookData: any): MessagePayload | null {
    if (platform === 'telegram') {
      const data = Array.isArray(webhookData) ? webhookData[0] : webhookData;
      return this._processTelegramWebhook(data);
    } else if (platform === 'whatsapp') {
      return this._processWhatsAppWebhook(webhookData);
    } else if (platform === 'web') {
      return this._processWebChatWebhook(webhookData);
    }
    return null;
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

  /**
   * Process web chat webhook
   */
  private _processWebChatWebhook(webhookData: any): MessagePayload | null {
    const { chat } = webhookData;
    if (!chat) return null;

    const platformId = chat.id;
    const username = chat.username;

    let inputType: InputType | null = null;
    let content: string | null = null;

    if (chat.message.file) {
      inputType = 'audio';
      content = chat.message.file; // Base64 encoded audio
    } else if (chat.message.text) {
      inputType = 'text';
      content = chat.message.text;
    }

    if (!inputType || !content) {
      return null;
    }

    return {
      platformId,
      platform: 'web',
      inputType,
      content,
      chatId: platformId,
      rawData: webhookData,
      userData: {
        firstName: username,
        username: username,
        chatId: platformId
      }
    };
  }

  private async _processMessage(messageData: MessagePayload) {
    const user = await this._ensureUserExists(messageData);
    
    try {
      // Process audio content if needed
      let processedContent = messageData.content;
      
      if (messageData.inputType === 'audio') {
        processedContent = await this._processAudioContent(messageData);
      }

      // Invoke the orchestrator with processed content
      const finalState = await orchestratorService.handleUserMessage(
        user.id,
        messageData.inputType,
        processedContent,
        messageData.platform,
        messageData.rawData
      );

      logUserAction(user.id, 'message_processed', { 
        platform: messageData.platform,
        inputType: messageData.inputType 
      });

      // Extract the response text from the result
      const responseText = finalState?.agentOutcome as string;

      // If there's a response, send it back to the user
      if (responseText) {
        await this.sendMessage(
          user.id,
          messageData.platform,
          undefined, // audioUrl - could be implemented later for TTS
          responseText
        );
      } else {
        logger.warn('Orchestrator graph finished but provided no response to send.', { userId: user.id });
      }

    } catch (error) {
      logger.error('Error during message processing orchestration:', { 
        platformId: messageData.platformId,
        platform: messageData.platform,
        error 
      });
      
      // Attempt to send a generic error message back to the user
      try {
        await this.sendMessage(
          user.id,
          messageData.platform,
          undefined,
          "I'm sorry, I seem to have encountered a technical problem. Please give me a moment."
        );
      } catch (sendError) {
        logger.error('Failed to send error message to user after processing failure.', { userId: user.id, sendError });
      }

      throw error;
    }
  }

  /**
   * Process audio content based on platform
   */
  private async _processAudioContent(messageData: MessagePayload): Promise<string> {
    let audioBuffer: Buffer;
    let audioUrl: string;

    try {
      if (messageData.platform === 'telegram') {
        audioBuffer = await this.downloadTelegramAudio(messageData.content);
        audioUrl = await this._uploadAudioToS3(audioBuffer, 'telegram', messageData.platformId);
      } else if (messageData.platform === 'whatsapp') {
        audioBuffer = await this.downloadWhatsAppAudio(messageData.content);
        audioUrl = await this._uploadAudioToS3(audioBuffer, 'whatsapp', messageData.platformId);
      } else if (messageData.platform === 'web') {
        audioBuffer = await this.processWebChatAudio(messageData.content);
        audioUrl = await this._uploadAudioToS3(audioBuffer, 'web', messageData.platformId);
      } else {
        throw createError(`Unsupported platform for audio processing: ${messageData.platform}`, 400);
      }

      logger.info('Audio processed and uploaded to S3', {
        platform: messageData.platform,
        platformId: messageData.platformId,
        audioUrl,
        audioSize: audioBuffer.length
      });

      return audioUrl;
    } catch (error) {
      logger.error('Error processing audio content:', {
        platform: messageData.platform,
        platformId: messageData.platformId,
        error
      });
      throw createError('Failed to process audio content', 500);
    }
  }

  /**
   * Upload audio buffer to S3 and return public URL
   */
  private async _uploadAudioToS3(audioBuffer: Buffer, platform: string, platformId: string): Promise<string> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const audioId = uuidv4();
      const key = `audio/${platform}/${platformId}/${timestamp}-${audioId}.ogg`;

      const command = new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: key,
        Body: audioBuffer,
        ContentType: 'audio/ogg',
        ACL: 'public-read'
      });

      await s3Client.send(command);

      // Construct public URL
      const publicUrl = env.S3_ENDPOINT 
        ? `${env.S3_ENDPOINT}/${this.s3Bucket}/${key}`
        : `https://${this.s3Bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;

      logger.info('Audio uploaded to S3 successfully', {
        key,
        publicUrl,
        size: audioBuffer.length
      });

      return publicUrl;
    } catch (error) {
      logger.error('Error uploading audio to S3:', error);
      throw createError('Failed to upload audio to storage', 500);
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
        [messageData.platform === 'telegram' ? 'telegramId' : 
         messageData.platform === 'whatsapp' ? 'whatsappId' : 
         'webChatId']: messageData.platformId,
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

  /**
   * Download Telegram audio file
   */
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

  /**
   * Download WhatsApp audio file
   */
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

  /**
   * Process base64 audio for web chat
   */
  async processWebChatAudio(base64Audio: string): Promise<Buffer> {
    try {
      // Remove data URL prefix if present (e.g., "data:audio/wav;base64,")
      const base64Data = base64Audio.replace(/^data:audio\/[a-z0-9]+;base64,/, '');
      
      // Convert base64 to buffer
      const audioBuffer = Buffer.from(base64Data, 'base64');
      
      // Validate audio size (max 10MB as per env config)
      const maxSize = env.MAX_AUDIO_FILE_SIZE_MB * 1024 * 1024;
      if (audioBuffer.length > maxSize) {
        throw createError(`Audio file too large. Max size: ${env.MAX_AUDIO_FILE_SIZE_MB}MB`, 400);
      }
      
      logger.info('Web chat audio processed successfully', {
        originalSize: base64Audio.length,
        bufferSize: audioBuffer.length
      });
      
      return audioBuffer;
    } catch (error) {
      logger.error('Error processing web chat audio:', error);
      throw createError('Failed to process audio file', 500);
    }
  }

  /**
   * Get messages for web chat (polling endpoint)
   */
  async getWebChatMessages(chatId: string, since?: string): Promise<any[]> {
    try {
      const listKey = `webchat:messages:${chatId}`;
      const messages = await redisManager.getClient().lrange(listKey, 0, -1);
      
      const parsedMessages = messages.map(msg => JSON.parse(msg));
      
      // Filter by timestamp if 'since' is provided
      if (since) {
        const sinceDate = new Date(since);
        return parsedMessages.filter(msg => new Date(msg.timestamp) > sinceDate);
      }
      
      return parsedMessages.reverse(); // Most recent first
    } catch (error) {
      logger.error('Error getting web chat messages:', { chatId, error });
      return [];
    }
  }

  /**
   * Upload generated audio response to S3 (for TTS responses)
   */
  async uploadResponseAudio(audioBuffer: Buffer, userId: string, sessionId?: string): Promise<string> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const audioId = sessionId || uuidv4();
      const key = `responses/${userId}/${timestamp}-${audioId}.mp3`;

      const command = new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: key,
        Body: audioBuffer,
        ContentType: 'audio/mpeg',
        ACL: 'public-read'
      });

      await s3Client.send(command);

      // Construct public URL
      const publicUrl = env.S3_ENDPOINT 
        ? `${env.S3_ENDPOINT}/${this.s3Bucket}/${key}`
        : `https://${this.s3Bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;

      logger.info('Response audio uploaded to S3 successfully', {
        key,
        publicUrl,
        size: audioBuffer.length,
        userId
      });

      return publicUrl;
    } catch (error) {
      logger.error('Error uploading response audio to S3:', { userId, error });
      throw createError('Failed to upload response audio to storage', 500);
    }
  }

  /**
   * Clear old messages from Redis (cleanup job)
   */
  async cleanupOldWebChatMessages(olderThanHours: number = 24): Promise<void> {
    try {
      const pattern = 'webchat:messages:*';
      const keys = await redisManager.getClient().keys(pattern);
      
      for (const key of keys) {
        const ttl = await redisManager.getClient().ttl(key);
        if (ttl > 0 && ttl < (olderThanHours * 3600)) {
          await redisManager.getClient().del(key);
          logger.debug('Cleaned up old web chat messages', { key });
        }
      }
      
      logger.info('Web chat messages cleanup completed', { 
        keysProcessed: keys.length,
        olderThanHours 
      });
    } catch (error) {
      logger.error('Error during web chat messages cleanup:', error);
    }
  }
}

export const messagingGatewayService = new MessagingGatewayService();