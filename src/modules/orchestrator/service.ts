import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { logger } from '../../utils/logger.js';
import { Platform, User } from '../../types/index.js';
import { userService } from '../users/service.js';
import { createError } from '../../middleware/errorHandler.js';
import prisma from '../../config/database.js';
import { graphService } from '../graph/service.js';
import { tracer } from '../../utils/tracer.js';
import { transcribeAudio } from '../../services/speechToText.js';
import { synthesizeText, textToSpeechService } from '../../services/textToSpeech.js';
import { messagingGatewayService } from '../gateway/service.js';
import { llmManager } from '../../config/llm.js';
import env from '../../config/environment.js';

/**
 * The main orchestrator service prepares the state and invokes the LangGraph-based
 * conversational flow.
 */
export class OrchestratorService {
  private compiledGraph: any;

  constructor() {
    this.initializeGraph();
  }

  private async initializeGraph() {
    try {
      logger.info('Initializing conversational graph...');
      await graphService.loadAgentsFromDb();
      this.compiledGraph = graphService.buildGraph();
      logger.info('Conversational graph compiled and ready.');
    } catch (error) {
      logger.error('Error loading agents from database:', error);
      throw new Error(`Failed to initialize conversational graph: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handles incoming user message by invoking the conversational graph.
   */
  async handleUserMessage(
    userId: string,
    inputType: 'text' | 'audio',
    content: string,
    platform: Platform,
    messageData: any
  ): Promise<any> {
    let audioUrl: string | undefined;

    try {
      logger.info(`Processing ${inputType} message for user ${userId} on ${platform}`);
      
      const user = await userService.getUserById(userId);
      if (!user) throw createError(`User not found: ${userId}`, 404);

      let textInput = content;
      
      // For audio input, content is already the S3 URL from gateway processing
      if (inputType === 'audio') {
        try {
          // Download audio from S3 URL and transcribe
          const audioBuffer = await this._downloadAudioFromUrl(content);
          textInput = await transcribeAudio(audioBuffer, {
            language: user.language === 'es' ? 'es' : 'en',
            model: 'whisper-1'
          });
          
          logger.info('Audio transcribed successfully', { 
            userId, 
            audioUrl: content, 
            platform,
            transcriptionLength: textInput.length,
            transcriptionPreview: textInput.substring(0, 100) + '...'
          });
        } catch (error) {
          logger.error('Failed to transcribe audio:', { userId, audioUrl: content, error });
          throw createError('Failed to process audio message', 500);
        }
      }
      
      tracer.userInput(textInput);

      // Save user message to chat history
      await this._saveToChatHistory(user.id, 'user', textInput);
      
      // Load recent chat history
      const history = await this._loadChatHistory(user.id);

      // Prepare initial state for the graph
      const initialState = {
        user,
        messages: [...history, new HumanMessage(textInput)],
        userMessage: textInput, // Explicit user message
        nextAgent: '',
        agentOutcome: '',
        lastAgent: ''
      };

      logger.debug('Initial graph state:', {
        userId: user.id,
        userMessage: textInput,
        historyLength: history.length,
        userLevel: user.cefrLevel,
        isOnboarding: user.isOnboarding,
        onboardingStep: user.onboardingStep
      });

      // Invoke the conversational graph
      const finalState = await this.compiledGraph.invoke(initialState);
      
      // Extract the agent response
      const agentResponse = finalState.agentOutcome;
      const agentName = finalState.lastAgent;

      logger.info('Graph execution completed', {
        userId: user.id,
        lastAgent: agentName,
        hasResponse: !!agentResponse,
        responseLength: typeof agentResponse === 'string' ? agentResponse.length : 0
      });

      if (typeof agentResponse === 'string' && agentResponse) {
        // Save assistant response to chat history
        await this._saveToChatHistory(user.id, 'assistant', agentResponse, agentName);
        
        // Generate audio response if TTS is available
        
        if (textToSpeechService.isAvailable()) {
          try {
            const audioBuffer = await synthesizeText(agentResponse, {
              language: user.language === 'es' ? 'es-ES' : 'en-US',
              voice: user.language === 'es' ? 'es-ES-Standard-A' : 'en-US-Standard-A'
            });
            
            audioUrl = await messagingGatewayService.uploadResponseAudio(audioBuffer, user.id);
            logger.info('Audio response generated successfully', { userId: user.id, audioUrl });
          } catch (error) {
            logger.warn('Failed to generate audio response, continuing with text only:', error);
          }
        }
        
        // Send response back to user
        await messagingGatewayService.sendMessage(user.id, platform, audioUrl, agentResponse);
        
        logger.info('Response sent successfully', {
          userId: user.id,
          platform,
          hasAudio: !!audioUrl,
          textLength: agentResponse.length
        });
      } else {
        logger.warn('No valid response from graph', { 
          userId: user.id, 
          lastAgent: agentName,
          agentOutcome: finalState.agentOutcome 
        });
        
        // Send fallback message
        const fallbackMessage = "I'm processing your message. Please give me a moment.";
        await messagingGatewayService.sendMessage(user.id, platform, undefined, fallbackMessage);
      }

      return { 
        ...finalState, 
        agentOutcome: agentResponse, 
        audioGenerated: !!audioUrl 
      };

    } catch (error) {
      logger.error('Critical error in orchestrator service:', {
        userId, 
        platform, 
        inputType,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      
      // Try to send error message to user
      try {
        const user = await userService.getUserById(userId);
        if (user) {
          await messagingGatewayService.sendMessage(
            user.id, 
            platform, 
            undefined, 
            "I'm sorry, I'm having technical difficulties. Please try again in a moment."
          );
        }
      } catch (sendError) {
        logger.error('Failed to send error message to user:', sendError);
      }
      
      throw error;
    }
  }

  private async _loadChatHistory(userId: string): Promise<BaseMessage[]> {
    try {
      const history = await prisma.chatHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: env.CHAT_HISTORY_WINDOW_SIZE,
      });

      // Reverse to get chronological order
      return history.reverse().map(msg => {
        if (msg.role === 'user') {
          return new HumanMessage(msg.content);
        }
        return new AIMessage(msg.content);
      });
    } catch (error) {
      logger.error('Error loading chat history:', { userId, error });
      return [];
    }
  }

  private async _saveToChatHistory(userId: string, role: 'user' | 'assistant', content: string, agentName?: string) {
    try {
      await prisma.chatHistory.create({
        data: { userId, role, content, agentName },
      });
    } catch (error) {
      logger.error('Error saving to chat history:', { userId, role, error });
    }
  }

  /**
   * Download audio file from S3 URL
   */
  private async _downloadAudioFromUrl(audioUrl: string): Promise<Buffer> {
    try {
      const response = await fetch(audioUrl);
      if (!response.ok) {
        throw new Error(`Failed to download audio: ${response.status} ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      logger.error('Error downloading audio from URL:', { audioUrl, error });
      throw new Error(`Failed to download audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

export const orchestratorService = new OrchestratorService();