import { OpenAI } from 'openai';
import { GoogleAuth } from 'google-auth-library';
import axios from 'axios';
import { logger, logApiCall } from '../utils/logger.js';
import { createError } from '../middleware/errorHandler.js';
import env from '../config/environment.js';
import fs from 'fs';
import { Readable } from 'stream';

export interface STTProvider {
  name: string;
  isConfigured: boolean;
  priority: number;
  transcribe: (audioBuffer: Buffer, options?: STTOptions) => Promise<string>;
}

export interface STTOptions {
  language?: string;
  model?: string;
  temperature?: number;
}

/**
 * Speech-to-Text service with multiple provider fallback
 */
class SpeechToTextService {
  private providers: STTProvider[] = [];
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor() {
    this.initializeProviders();
  }

  private initializeProviders() {
    // OpenAI Whisper (Priority 1 - most reliable)
    if (env.OPENAI_API_KEY) {
      const openai = new OpenAI({
        apiKey: env.OPENAI_API_KEY,
        timeout: env.OPENAI_API_TIMEOUT,
      });

      this.providers.push({
        name: 'openai-whisper',
        isConfigured: true,
        priority: 1,
        transcribe: async (audioBuffer: Buffer, options?: STTOptions) => {
          return await this.transcribeWithOpenAI(openai, audioBuffer, options);
        }
      });

      logger.info('OpenAI Whisper STT initialized successfully');
    }

    // Google Speech-to-Text (Priority 2)
    if (env.GOOGLE_API_KEY || env.GOOGLE_APPLICATION_CREDENTIALS) {
      this.providers.push({
        name: 'google-stt',
        isConfigured: true,
        priority: 2,
        transcribe: async (audioBuffer: Buffer, options?: STTOptions) => {
          return await this.transcribeWithGoogle(audioBuffer, options);
        }
      });

      logger.info('Google Speech-to-Text initialized successfully');
    }

    // DeepSeek STT (Priority 3) - if they add STT support
    if (env.DEEPSEEK_API_KEY && env.DEEPSEEK_STT_ENABLED === 'true') {
      this.providers.push({
        name: 'deepseek-stt',
        isConfigured: true,
        priority: 3,
        transcribe: async (audioBuffer: Buffer, options?: STTOptions) => {
          return await this.transcribeWithDeepSeek(audioBuffer, options);
        }
      });

      logger.info('DeepSeek STT initialized successfully');
    }

    // Sort by priority
    this.providers.sort((a, b) => a.priority - b.priority);

    const configuredProviders = this.providers.filter(p => p.isConfigured);
    if (configuredProviders.length === 0) {
      logger.error('No STT providers are configured!');
      throw new Error('No STT providers available');
    }

    logger.info('STT Service initialized with providers:', {
      total: this.providers.length,
      configured: configuredProviders.length,
      providers: configuredProviders.map(p => ({ name: p.name, priority: p.priority }))
    });
  }

  /**
   * Main transcription method with fallback
   */
  async transcribe(audioBuffer: Buffer, options?: STTOptions): Promise<string> {
    const startTime = Date.now();
    const configuredProviders = this.providers.filter(p => p.isConfigured);
    
    // Validate audio buffer
    if (!audioBuffer || audioBuffer.length === 0) {
      throw createError('Invalid audio buffer provided', 400);
    }

    // Check audio size (max 25MB for most providers)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (audioBuffer.length > maxSize) {
      throw createError(`Audio file too large. Max size: 25MB, received: ${(audioBuffer.length / 1024 / 1024).toFixed(2)}MB`, 400);
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      for (const provider of configuredProviders) {
        try {
          logger.debug(`Attempting transcription with ${provider.name} (attempt ${attempt}/${this.maxRetries})`);
          
          const transcription = await provider.transcribe(audioBuffer, options);
          
          if (!transcription || transcription.trim().length === 0) {
            throw new Error('Empty transcription returned');
          }

          // Validate transcription quality
          if (transcription.length < 3) {
            logger.warn(`Short transcription from ${provider.name}: "${transcription}"`);
          }

          const duration = Date.now() - startTime;
          logApiCall(provider.name, 'transcribe', duration, true);
          
          logger.info(`Transcription successful with ${provider.name}`, {
            duration: `${duration}ms`,
            audioSize: `${(audioBuffer.length / 1024).toFixed(2)}KB`,
            transcriptionLength: transcription.length,
            attempt
          });

          return transcription.trim();

        } catch (error) {
          lastError = error instanceof Error ? error : new Error('Unknown STT error');
          
          const duration = Date.now() - startTime;
          logApiCall(provider.name, 'transcribe', duration, false, lastError.message);
          
          logger.warn(`${provider.name} transcription failed (attempt ${attempt}/${this.maxRetries}):`, {
            error: lastError.message,
            audioSize: `${(audioBuffer.length / 1024).toFixed(2)}KB`,
            duration: `${duration}ms`
          });
        }
      }
      
      // Wait before next retry cycle
      if (attempt < this.maxRetries) {
        logger.info(`All STT providers failed on attempt ${attempt}. Retrying in ${this.retryDelay}ms...`);
        await this.sleep(this.retryDelay);
        this.retryDelay *= 2; // Exponential backoff
      }
    }

    // All providers failed
    const totalDuration = Date.now() - startTime;
    logger.error('All STT providers failed after all retries', {
      attempts: this.maxRetries,
      providers: configuredProviders.map(p => p.name),
      totalDuration: `${totalDuration}ms`,
      lastError: lastError?.message
    });

    throw createError(
      `Speech transcription failed: ${lastError?.message || 'All providers unavailable'}`,
      503
    );
  }

  /**
   * OpenAI Whisper transcription
   */
  private async transcribeWithOpenAI(openai: OpenAI, audioBuffer: Buffer, options?: STTOptions): Promise<string> {
    try {
      // Create a temporary file-like object for OpenAI API
      const audioFile = new File([audioBuffer], 'audio.ogg', { type: 'audio/ogg' });
      
      const response = await openai.audio.transcriptions.create({
        file: audioFile,
        model: options?.model || 'whisper-1',
        language: options?.language || 'en',
        temperature: options?.temperature || 0,
        response_format: 'text'
      });

      return response;
    } catch (error) {
      logger.error('OpenAI Whisper transcription error:', error);
      throw new Error(`OpenAI Whisper failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Google Speech-to-Text transcription
   */
  private async transcribeWithGoogle(audioBuffer: Buffer, options?: STTOptions): Promise<string> {
    try {
      let auth;
      
      if (env.GOOGLE_APPLICATION_CREDENTIALS) {
        auth = new GoogleAuth({
          keyFile: env.GOOGLE_APPLICATION_CREDENTIALS,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
      } else if (env.GOOGLE_API_KEY) {
        // Use API key authentication
        auth = env.GOOGLE_API_KEY;
      } else {
        throw new Error('No Google credentials configured');
      }

      const audioContent = audioBuffer.toString('base64');
      
      const requestBody = {
        config: {
          encoding: 'OGG_OPUS',
          sampleRateHertz: 16000,
          languageCode: options?.language || 'en-US',
          model: 'latest_long',
          useEnhanced: true,
        },
        audio: {
          content: audioContent,
        },
      };

      let response;
      
      if (typeof auth === 'string') {
        // API Key authentication
        response = await axios.post(
          `https://speech.googleapis.com/v1/speech:recognize?key=${auth}`,
          requestBody,
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
          }
        );
      } else {
        // Service account authentication
        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();
        
        response = await axios.post(
          'https://speech.googleapis.com/v1/speech:recognize',
          requestBody,
          {
            headers: {
              'Authorization': `Bearer ${accessToken.token}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );
      }

      const results = response.data.results;
      if (!results || results.length === 0) {
        throw new Error('No transcription results from Google STT');
      }

      const transcription = results
        .map((result: any) => result.alternatives[0]?.transcript || '')
        .join(' ')
        .trim();

      if (!transcription) {
        throw new Error('Empty transcription from Google STT');
      }

      return transcription;
    } catch (error) {
      logger.error('Google STT transcription error:', error);
      throw new Error(`Google STT failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * DeepSeek STT transcription (placeholder for future implementation)
   */
  private async transcribeWithDeepSeek(audioBuffer: Buffer, options?: STTOptions): Promise<string> {
    try {
      // This is a placeholder - DeepSeek doesn't have STT yet
      // When they add it, implement similar to OpenAI
      throw new Error('DeepSeek STT not yet implemented');
    } catch (error) {
      logger.error('DeepSeek STT transcription error:', error);
      throw new Error(`DeepSeek STT failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get provider status
   */
  getProviderStatus(): { name: string; configured: boolean; priority: number }[] {
    return this.providers.map(p => ({
      name: p.name,
      configured: p.isConfigured,
      priority: p.priority
    }));
  }

  /**
   * Refresh providers
   */
  async refreshProviders(): Promise<void> {
    logger.info('Refreshing STT providers...');
    this.providers = [];
    this.retryDelay = 1000;
    this.initializeProviders();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const speechToTextService = new SpeechToTextService();

// Export convenience function
export async function transcribeAudio(audioBuffer: Buffer, options?: STTOptions): Promise<string> {
  return await speechToTextService.transcribe(audioBuffer, options);
}