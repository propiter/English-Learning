import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { PromptTemplate } from '@langchain/core/prompts';
import { logger } from '../utils/logger.js';
import env from './environment.js';

export interface LLMProvider {
  name: string;
  model: string;
  client: any;
  isConfigured: boolean;
  priority: number;
}

export interface LLMConfig {
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  structuredOutput?: boolean;
  outputSchema?: any;
}

/**
 * LLM Manager con sistema de fallback dinámico basado en configuración
 */
class LLMManager {
  private providers: LLMProvider[] = [];
  private maxRetries = 3;
  private retryDelay = 1000; // 1 second

  constructor() {
    this.initializeProviders();
  }

  private initializeProviders() {
    logger.info('Inicializando proveedores LLM disponibles...');

    // Google Gemini (Priority 1) - Solo si está configurado
    if (env.GOOGLE_API_KEY) {
      try {
        const googleClient = new ChatGoogleGenerativeAI({
          model: env.GOOGLE_MODEL_NAME || 'models/gemini-2.0-flash-lite-preview-02-05',
          apiKey: env.GOOGLE_API_KEY, 
          temperature: 0.2,
          maxOutputTokens: 4096,
        });
        

        this.providers.push({
          name: 'google',
          model: env.GOOGLE_MODEL_NAME || 'models/gemini-2.0-flash-lite-preview-02-05',
          client: googleClient,
          isConfigured: true,
          priority: 1
        });

        logger.info('✅ Google Gemini LLM configurado correctamente');
      } catch (error) {
        logger.warn('❌ Error configurando Google Gemini LLM:', error);
        this.providers.push({
          name: 'google',
          model: 'models/gemini-2.0-flash-lite-preview-02-05',
          client: null,
          isConfigured: false,
          priority: 1
        });
      }
    } else {
      logger.info('⚠️ Google Gemini no configurado (GOOGLE_API_KEY no encontrada)');
    }

    // OpenAI (Priority 2) - Solo si está configurado
    if (env.OPENAI_API_KEY) {
      try {
        const openaiClient = new ChatOpenAI({
          modelName: env.OPENAI_MODEL_NAME || 'gpt-4-turbo',
          apiKey: env.OPENAI_API_KEY,
          temperature: 0.2,
          maxTokens: 4096,
          timeout: env.OPENAI_API_TIMEOUT,
        });

        this.providers.push({
          name: 'openai',
          model: env.OPENAI_MODEL_NAME || 'gpt-4-turbo',
          client: openaiClient,
          isConfigured: true,
          priority: 2
        });

        logger.info('✅ OpenAI LLM configurado correctamente');
      } catch (error) {
        logger.warn('❌ Error configurando OpenAI LLM:', error);
        this.providers.push({
          name: 'openai',
          model: 'gpt-4-turbo',
          client: null,
          isConfigured: false,
          priority: 2
        });
      }
    } else {
      logger.info('⚠️ OpenAI no configurado (OPENAI_API_KEY no encontrada)');
    }

    // DeepSeek (Priority 3) - Solo si está configurado
    if (env.DEEPSEEK_API_KEY) {
      try {
        const deepseekClient = new ChatOpenAI({
          modelName: env.DEEPSEEK_MODEL_NAME || 'deepseek-chat',
          apiKey: env.DEEPSEEK_API_KEY,
          configuration: {
            baseURL: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
          },
          temperature: 0.2,
          maxTokens: 4096,
        });

        this.providers.push({
          name: 'deepseek',
          model: env.DEEPSEEK_MODEL_NAME || 'deepseek-chat',
          client: deepseekClient,
          isConfigured: true,
          priority: 3
        });

        logger.info('✅ DeepSeek LLM configurado correctamente');
      } catch (error) {
        logger.warn('❌ Error configurando DeepSeek LLM:', error);
        this.providers.push({
          name: 'deepseek',
          model: 'deepseek-chat',
          client: null,
          isConfigured: false,
          priority: 3
        });
      }
    } else {
      logger.info('⚠️ DeepSeek no configurado (DEEPSEEK_API_KEY no encontrada)');
    }

    // Ordenar por prioridad y filtrar solo los configurados
    this.providers.sort((a, b) => a.priority - b.priority);
    const configuredProviders = this.providers.filter(p => p.isConfigured);

    if (configuredProviders.length === 0) {
      logger.error('🚨 CRÍTICO: No hay proveedores LLM configurados! Verifica tus variables de entorno.');
      throw new Error('No LLM providers available - check your environment variables');
    }

    logger.info('🎯 LLM Manager inicializado exitosamente:', {
      totalProviders: this.providers.length,
      configuredProviders: configuredProviders.length,
      activeProviders: configuredProviders.map(p => ({ 
        name: p.name, 
        model: p.model, 
        priority: p.priority 
      })),
      fallbackStrategy: configuredProviders.length > 1 ? 'Habilitado' : 'Deshabilitado (solo 1 proveedor)'
    });
  }

  /**
   * Obtiene cliente LLM con fallback automático entre proveedores configurados
   */
  async getLLMClient(config?: LLMConfig): Promise<any> {
    const configuredProviders = this.providers.filter(p => p.isConfigured);
    
    if (configuredProviders.length === 0) {
      throw new Error('No LLM providers configured');
    }

    // Si solo hay un proveedor, úsalo directamente
    if (configuredProviders.length === 1) {
      const provider = configuredProviders[0];
      logger.info(`🎯 Usando único proveedor disponible: ${provider.name}`);
      return this.configureClient(provider, config);
    }

    // Sistema de fallback para múltiples proveedores
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      for (const provider of configuredProviders) {
        try {
          logger.debug(`🔄 Intentando ${provider.name} (intento ${attempt}/${this.maxRetries})`);
          
          // Test rápido del proveedor
          await this.testProvider(provider.client, config);
          
          logger.info(`✅ Conectado exitosamente a ${provider.name} LLM`);
          return this.configureClient(provider, config);
          
        } catch (error) {
          lastError = error instanceof Error ? error : new Error('Unknown error');
          
          logger.warn(`❌ ${provider.name} falló (intento ${attempt}/${this.maxRetries}):`, {
            error: lastError.message,
            provider: provider.name,
            model: provider.model,
            willRetry: attempt < this.maxRetries || provider !== configuredProviders[configuredProviders.length - 1]
          });
          
          // Si no es el último proveedor o último intento, continúa
          if (provider !== configuredProviders[configuredProviders.length - 1] || attempt < this.maxRetries) {
            continue;
          }
        }
      }
      
      // Esperar antes del siguiente ciclo de reintentos
      if (attempt < this.maxRetries) {
        logger.info(`⏳ Todos los proveedores fallaron en intento ${attempt}. Reintentando en ${this.retryDelay}ms...`);
        await this.sleep(this.retryDelay);
        this.retryDelay *= 2; // Backoff exponencial
      }
    }

    // Todos los proveedores fallaron después de todos los reintentos
    const error = new Error(`Todos los proveedores LLM fallaron después de ${this.maxRetries} intentos`);
    logger.error('🚨 LLM Manager: Fallo completo', {
      attempts: this.maxRetries,
      providers: configuredProviders.map(p => p.name),
      lastError: lastError?.message
    });
    throw error;
  }

  /**
   * Prueba si un proveedor está funcionando
   */
  private async testProvider(client: any, config?: LLMConfig): Promise<void> {
    const configuredClient = this.configureBasicClient(client, config);
    
    // Mensaje de prueba simple
    const testResponse = await configuredClient.invoke([
      { role: 'user', content: 'Responde solo "OK"' }
    ]);
    
    if (!testResponse || !testResponse.content) {
      throw new Error(`Provider devolvió respuesta vacía`);
    }

    // Validación adicional del contenido
    if (typeof testResponse.content !== 'string' || testResponse.content.trim().length === 0) {
      throw new Error(`Provider devolvió contenido inválido`);
    }
  }

  /**
   * Configura cliente con configuración personalizada y soporte para structured output
   */
  private configureClient(provider: LLMProvider, config?: LLMConfig): any {
    if (!config) return provider.client;

    const client = provider.client;
    
    // Configuración básica del cliente
    const configuredClient = this.configureBasicClient(client, config);
    
    // Si se requiere structured output, configurarlo según el proveedor
    if (config.structuredOutput && config.outputSchema) {
      return this.addStructuredOutput(provider, configuredClient, config.outputSchema);
    }
    
    return configuredClient;
  }

  /**
   * Configuración básica del cliente (temperatura, tokens, etc.)
   */
  private configureBasicClient(client: any, config?: LLMConfig): any {
    if (!config) return client;
    
    return client.bind({
      temperature: config.temperature ?? client.temperature,
      maxTokens: config.maxTokens ?? client.maxTokens,
      timeout: config.timeout ?? client.timeout,
    });
  }

  /**
   * Añade soporte para structured output según el proveedor
   */
  private addStructuredOutput(provider: LLMProvider, client: any, outputSchema: any): any {
    if (provider.name === 'openai') {
      // OpenAI tiene soporte nativo para structured output
      return client.withStructuredOutput(outputSchema, {
        method: "tool_calling",
      });
    } else if (provider.name === 'google') {
      // Google Gemini requiere un enfoque diferente usando JsonOutputParser
      const parser = new JsonOutputParser();
      
      // Crear un prompt que instruya al modelo a devolver JSON válido
      const structuredPrompt = PromptTemplate.fromTemplate(`
{input}

IMPORTANTE: Tu respuesta debe ser un JSON válido que siga exactamente este esquema:
{schema}

Responde ÚNICAMENTE con el JSON, sin texto adicional antes o después.
`);
      
      // Crear una cadena que combine el prompt estructurado con el parser
      return structuredPrompt
        .pipe(client)
        .pipe(parser)
        .bind({
          schema: JSON.stringify(outputSchema.parameters || outputSchema, null, 2)
        });
    } else if (provider.name === 'deepseek') {
      // DeepSeek usa la misma API que OpenAI, pero puede no tener structured output
      // Intentamos primero con structured output, si falla usamos JSON parser
      try {
        return client.withStructuredOutput(outputSchema, {
          method: "tool_calling",
        });
      } catch (error) {
        logger.warn('DeepSeek no soporta structured output nativo, usando JSON parser');
        const parser = new JsonOutputParser();
        
        const structuredPrompt = PromptTemplate.fromTemplate(`
{input}

IMPORTANTE: Tu respuesta debe ser un JSON válido que siga exactamente este esquema:
{schema}

Responde ÚNICAMENTE con el JSON, sin texto adicional antes o después.
`);
        
        return structuredPrompt
          .pipe(client)
          .pipe(parser)
          .bind({
            schema: JSON.stringify(outputSchema.parameters || outputSchema, null, 2)
          });
      }
    }
    
    // Fallback para otros proveedores
    logger.warn(`Structured output no implementado para ${provider.name}, usando JSON parser genérico`);
    const parser = new JsonOutputParser();
    
    const structuredPrompt = PromptTemplate.fromTemplate(`
{input}

IMPORTANTE: Tu respuesta debe ser un JSON válido que siga exactamente este esquema:
{schema}

Responde ÚNICAMENTE con el JSON, sin texto adicional antes o después.
`);
    
    return structuredPrompt
      .pipe(client)
      .pipe(parser)
      .bind({
        schema: JSON.stringify(outputSchema.parameters || outputSchema, null, 2)
      });
  }

  /**
   * Método de conveniencia para obtener cliente con structured output
   */
  async getStructuredLLMClient(outputSchema: any, config?: Omit<LLMConfig, 'structuredOutput' | 'outputSchema'>): Promise<any> {
    return await this.getLLMClient({
      ...config,
      structuredOutput: true,
      outputSchema
    });
  }

  /**
   * Obtiene estado de proveedores para monitoreo
   */
  getProviderStatus(): { name: string; configured: boolean; priority: number; model: string }[] {
    return this.providers.map(p => ({
      name: p.name,
      configured: p.isConfigured,
      priority: p.priority,
      model: p.model
    }));
  }

  /**
   * Obtiene resumen de configuración actual
   */
  getConfigurationSummary(): {
    totalProviders: number;
    configuredProviders: number;
    activeProviders: string[];
    fallbackEnabled: boolean;
    primaryProvider: string | null;
  } {
    const configuredProviders = this.providers.filter(p => p.isConfigured);
    
    return {
      totalProviders: this.providers.length,
      configuredProviders: configuredProviders.length,
      activeProviders: configuredProviders.map(p => p.name),
      fallbackEnabled: configuredProviders.length > 1,
      primaryProvider: configuredProviders.length > 0 ? configuredProviders[0].name : null
    };
  }

  /**
   * Fuerza actualización de proveedores (útil para cambios de configuración en runtime)
   */
  async refreshProviders(): Promise<void> {
    logger.info('🔄 Actualizando proveedores LLM...');
    this.providers = [];
    this.retryDelay = 1000; // Reset retry delay
    this.initializeProviders();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Exportar instancia singleton
export const llmManager = new LLMManager();

// Exportar función de conveniencia
export async function getLLMClient(config?: LLMConfig): Promise<any> {
  return await llmManager.getLLMClient(config);
}