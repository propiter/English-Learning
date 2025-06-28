import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { logger } from '../../utils/logger.js';
import { Platform, User } from '../../types/index.js';
import { userService } from '../users/service.js';
import { createError } from '../../middleware/errorHandler.js';
import prisma from '../../config/database.js';
import { graphService } from '../graph/service.js';
import { tracer } from '../../utils/tracer.js';
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
    await graphService.loadAgentsFromDb();
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

      const textInput = content;
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
      }

      return { ...finalState, agentOutcome: agentResponse };

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
}

export const orchestratorService = new OrchestratorService();
