import { OpenAI } from 'openai';
import { GoogleAuth } from 'google-auth-library';
import axios from 'axios';
import { logger, logApiCall } from '../utils/logger.js';
import { createError } from '../middleware/errorHandler.js';
import env from '../config/environment.js';

export interface TTSProvider {
  name: string;
  isConfigured: boolean;
  priority: number;
  synthesize: (text: string, options?: TTSOptions) => Promise<Buffer>;
}

export interface TTSOptions {
  voice?: string;
  language?: string;
  speed?: number;
  format?: string;
}

/**
 * Text-to-Speech service with multiple provider fallback
 */
class TextToSpeechService {
  private providers: TTSProvider[] = [];
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor() {
    this.initializeProviders();
  }

  private initializeProviders() {
    logger.info('Inicializando proveedores Text-to-Speech disponibles...');

    // OpenAI TTS (Priority 1)
    if (env.OPENAI_API_KEY) {
      const openai = new OpenAI({
        apiKey: env.OPENAI_API_KEY,
        timeout: env.OPENAI_API_TIMEOUT,
      });

      this.providers.push({
        name: 'openai-tts',
        isConfigured: true,
        priority: 1,
        synthesize: async (text: string, options?: TTSOptions) => {
          return await this.synthesizeWithOpenAI(openai, text, options);
        }
      });

      logger.info('✅ OpenAI TTS configurado correctamente');
    } else {
      logger.info('⚠️ OpenAI TTS no configurado (OPENAI_API_KEY no encontrada)');
    }

    // Google Text-to-Speech (Priority 2)
    if (env.GOOGLE_API_KEY || env.GOOGLE_APPLICATION_CREDENTIALS) {
      this.providers.push({
        name: 'google-tts',
        isConfigured: true,
        priority: 2,
        synthesize: async (text: string, options?: TTSOptions) => {
          return await this.synthesizeWithGoogle(text, options);
        }
      });

      logger.info('✅ Google Text-to-Speech configurado correctamente');
    } else {
      logger.info('⚠️ Google Text-to-Speech no configurado (GOOGLE_API_KEY no encontrada)');
    }

    // Sort by priority
    this.providers.sort((a, b) => a.priority - b.priority);

    const configuredProviders = this.providers.filter(p => p.isConfigured);
    if (configuredProviders.length === 0) {
      logger.warn('⚠️ No hay proveedores TTS configurados - respuestas de audio deshabilitadas');
    } else {
      logger.info('🎯 TTS Service inicializado exitosamente:', {
        totalProviders: this.providers.length,
        configuredProviders: configuredProviders.length,
        activeProviders: configuredProviders.map(p => ({ 
          name: p.name, 
          priority: p.priority 
        })),
        fallbackStrategy: configuredProviders.length > 1 ? 'Habilitado' : 'Deshabilitado (solo 1 proveedor)'
      });
    }
  }

  /**
   * Main synthesis method with fallback
   */
  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const startTime = Date.now();
    const configuredProviders = this.providers.filter(p => p.isConfigured);
    
    if (configuredProviders.length === 0) {
      throw createError('No hay proveedores de Text-to-Speech configurados', 503);
    }

    // Si solo hay un proveedor, úsalo directamente
    if (configuredProviders.length === 1) {
      const provider = configuredProviders[0];
      logger.info(`🎯 Usando único proveedor TTS disponible: ${provider.name}`);
      
      try {
        const audioBuffer = await provider.synthesize(text, options);
        const duration = Date.now() - startTime;
        logApiCall(provider.name, 'synthesize', duration, true);
        
        logger.info(`✅ Síntesis exitosa con ${provider.name}`, {
          duration: `${duration}ms`,
          textLength: text.length,
          audioSize: `${(audioBuffer.length / 1024).toFixed(2)}KB`
        });
        
        return audioBuffer;
      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logApiCall(provider.name, 'synthesize', duration, false, errorMsg);
        
        logger.error(`❌ Único proveedor TTS ${provider.name} falló:`, {
          error: errorMsg,
          textLength: text.length,
          duration: `${duration}ms`
        });
        
        throw createError(`Síntesis de voz falló: ${errorMsg}`, 503);
      }
    }

    // Validate text input
    if (!text || text.trim().length === 0) {
      throw createError('Invalid text provided for synthesis', 400);
    }

    // Check text length (most providers have limits)
    const maxLength = 4000; // Conservative limit
    if (text.length > maxLength) {
      logger.warn(`Text too long for TTS (${text.length} chars), truncating to ${maxLength}`);
      text = text.substring(0, maxLength) + '...';
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      for (const provider of configuredProviders) {
        try {
          logger.debug(`Attempting TTS with ${provider.name} (attempt ${attempt}/${this.maxRetries})`);
          
          const audioBuffer = await provider.synthesize(text, options);
          
          if (!audioBuffer || audioBuffer.length === 0) {
            throw new Error('Empty audio buffer returned');
          }

          const duration = Date.now() - startTime;
          logApiCall(provider.name, 'synthesize', duration, true);
          
          logger.info(`TTS synthesis successful with ${provider.name}`, {
            duration: `${duration}ms`,
            textLength: text.length,
            audioSize: `${(audioBuffer.length / 1024).toFixed(2)}KB`,
            attempt
          });

          return audioBuffer;

        } catch (error) {
          lastError = error instanceof Error ? error : new Error('Unknown TTS error');
          
          const duration = Date.now() - startTime;
          logApiCall(provider.name, 'synthesize', duration, false, lastError.message);
          
          logger.warn(`${provider.name} TTS failed (attempt ${attempt}/${this.maxRetries}):`, {
            error: lastError.message,
            textLength: text.length,
            duration: `${duration}ms`
          });
        }
      }
      
      // Wait before next retry cycle
      if (attempt < this.maxRetries) {
        logger.info(`All TTS providers failed on attempt ${attempt}. Retrying in ${this.retryDelay}ms...`);
        await this.sleep(this.retryDelay);
        this.retryDelay *= 2; // Exponential backoff
      }
    }

    // All providers failed
    const totalDuration = Date.now() - startTime;
    logger.error('All TTS providers failed after all retries', {
      attempts: this.maxRetries,
      providers: configuredProviders.map(p => p.name),
      totalDuration: `${totalDuration}ms`,
      lastError: lastError?.message
    });

    throw createError(
      `Text-to-speech synthesis failed: ${lastError?.message || 'All providers unavailable'}`,
      503
    );
  }

  /**
   * OpenAI TTS synthesis
   */
  private async synthesizeWithOpenAI(openai: OpenAI, text: string, options?: TTSOptions): Promise<Buffer> {
    try {
      const response = await openai.audio.speech.create({
        model: 'tts-1',
        voice: (options?.voice as any) || 'alloy',
        input: text,
        response_format: options?.format || 'mp3',
        speed: options?.speed || 1.0,
      });

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      logger.error('OpenAI TTS synthesis error:', error);
      throw new Error(`OpenAI TTS failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Google Text-to-Speech synthesis
   */
  private async synthesizeWithGoogle(text: string, options?: TTSOptions): Promise<Buffer> {
    try {
      let auth;
      
      if (env.GOOGLE_APPLICATION_CREDENTIALS) {
        auth = new GoogleAuth({
          keyFile: env.GOOGLE_APPLICATION_CREDENTIALS,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
      } else if (env.GOOGLE_API_KEY) {
        auth = env.GOOGLE_API_KEY;
      } else {
        throw new Error('No Google credentials configured');
      }

      const requestBody = {
        input: { text },
        voice: {
          languageCode: options?.language || 'en-US',
          name: options?.voice || 'en-US-Standard-A',
          ssmlGender: 'NEUTRAL',
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: options?.speed || 1.0,
        },
      };

      let response;
      
      if (typeof auth === 'string') {
        // API Key authentication
        response = await axios.post(
          `https://texttospeech.googleapis.com/v1/text:synthesize?key=${auth}`,
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
          'https://texttospeech.googleapis.com/v1/text:synthesize',
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

      const audioContent = response.data.audioContent;
      if (!audioContent) {
        throw new Error('No audio content returned from Google TTS');
      }

      return Buffer.from(audioContent, 'base64');
    } catch (error) {
      logger.error('Google TTS synthesis error:', error);
      throw new Error(`Google TTS failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
   * Check if TTS is available
   */
  isAvailable(): boolean {
    return this.providers.some(p => p.isConfigured);
  }

  /**
   * Refresh providers
   */
  async refreshProviders(): Promise<void> {
    logger.info('Refreshing TTS providers...');
    this.providers = [];
    this.retryDelay = 1000;
    this.initializeProviders();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const textToSpeechService = new TextToSpeechService();

// Export convenience function
export async function synthesizeText(text: string, options?: TTSOptions): Promise<Buffer> {
  return await textToSpeechService.synthesize(text, options);
}