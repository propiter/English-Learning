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
      await graphService.loadAgentsFromDb();
    } catch (error) {
      logger.error('Error loading agents from database:', error);
      throw new Error(`Failed to initialize conversational graph: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    this.compiledGraph = graphService.buildGraph();
    logger.info('Conversational graph compiled and ready.');
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
    try {
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

      await this._saveToChatHistory(user.id, 'user', textInput);
      const history = await this._loadChatHistory(user.id);

      const initialState = {
        user,
        messages: [...history, new HumanMessage(textInput)],
      };

      const finalState = await this.compiledGraph.invoke(initialState);
      
      // The final AI response is the last message in the history that isn't a tool message.
      const lastMessage = [...finalState.messages].reverse().find(m => m._getType() === 'ai');
      const agentResponse = lastMessage?.content;
      const agentName = finalState.lastAgent; 

      if (typeof agentResponse === 'string' && agentResponse) {
        await this._saveToChatHistory(user.id, 'assistant', agentResponse, agentName);
        
        // Generate audio response if TTS is available
        let audioUrl: string | undefined;
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
      }

      return { ...finalState, agentOutcome: agentResponse, audioGenerated: !!audioUrl };

    } catch (error) {
      logger.error('Critical error in orchestrator service:', {
        userId, platform, error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async _loadChatHistory(userId: string): Promise<BaseMessage[]> {
    const history = await prisma.chatHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: env.CHAT_HISTORY_WINDOW_SIZE,
    });

    return history.map(msg => {
      if (msg.role === 'user') {
        return new HumanMessage(msg.content);
      }
      return new AIMessage(msg.content);
    });
  }

  private async _saveToChatHistory(userId: string, role: 'user' | 'assistant', content: string, agentName?: string) {
    await prisma.chatHistory.create({
      data: { userId, role, content, agentName },
    });
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
