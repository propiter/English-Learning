import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { logger } from '../../utils/logger.js';
import { Platform, User } from '../../types/index.js';
import { userService } from '../users/service.js';
import { createError } from '../../middleware/errorHandler.js';
import prisma from '../../config/database.js';
import { graphService } from '../graph/service.js';
import { tracer } from '../../lib/tracer.js';
import env from '../../config/environment.js';

/**
 * The main orchestrator service has been refactored. Its primary role is now to
 * prepare the state and invoke the LangGraph-based conversational flow.
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
    content: string, // Text message or file path to audio
    platform: Platform,
    messageData: any
  ): Promise<any> {
    try {
      const user = await userService.getUserById(userId);
      if (!user) throw createError(`User not found: ${userId}`, 404);

      // For now, we only handle text input. Audio transcription would happen here.
      const textInput = content;
      tracer.userInput(textInput);

      // Persist user's message to chat history
      await this._saveToChatHistory(user.id, 'user', textInput);

      // Load conversation history to provide context to the agents
      const history = await this._loadChatHistory(user.id);

      const initialState = {
        user,
        messages: [...history, new HumanMessage(textInput)],
      };

      // Stream the graph execution to get the final state
      let finalStep;
      for await (const step of await this.compiledGraph.stream(initialState)) {
        // The last step in the stream is the final state of the graph.
        finalStep = step;
      }
      
      // The final step is an object like { nodeName: state }, so we extract the state.
      const finalState = finalStep[Object.keys(finalStep)[0]];
      const agentResponse = finalState.agentOutcome;
      // FIX: Use `lastAgent` which is explicitly set by the node that ran.
      const agentName = finalState.lastAgent; 

      // Persist agent's final response to chat history
      if (typeof agentResponse === 'string') {
        await this._saveToChatHistory(user.id, 'assistant', agentResponse, agentName);
      }

      return finalState;

    } catch (error) {
      logger.error('Critical error in orchestrator service:', {
        userId, platform, error: error instanceof Error ? error.message : 'Unknown error',
      });
      // In a real app, you'd send a user-facing error message here.
      throw error;
    }
  }

  private async _loadChatHistory(userId: string): Promise<BaseMessage[]> {
    const history = await prisma.chatHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: env.CHAT_HISTORY_WINDOW_SIZE,
    });

    // Reverse to maintain chronological order and map to LangChain message types
    return history.reverse().map(msg => {
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
