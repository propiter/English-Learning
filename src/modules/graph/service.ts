import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StateGraph, END } from '@langchain/langgraph';
import { Runnable } from '@langchain/core/runnables';
import { z } from 'zod';
import prisma from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { tracer } from '../../utils/tracer.js';
import { User } from '../../types/index.js';
import { llmManager } from '../../config/llm.js';
import { allTools } from '../agents/tools.js';
import { JsonOutputParser } from '@langchain/core/output_parsers'
/**
 * Defines the state that flows through the graph.
 * Each node can modify this state.
 */
interface GraphState {
  user: User;
  messages: BaseMessage[];
  nextAgent: string;
  agentOutcome: string | object;
  lastAgent: string;
  userMessage: string; // Add explicit user message
}

/**
 * A map to hold our dynamically loaded agent runnables.
 */
const agentRunnables: Record<string, Runnable> = {};

/**
 * Defines the JSON schema for the orchestrator's output.
 */
const orchestratorSchema = z.object({
  agent_to_invoke: z.string().describe("The name of the agent to invoke next. Must be one of: 'onboarding', 'daily_practice', 'meta_query', 'short_response', 'customer_service', 'text_summary'"),
  reasoning: z.string().describe("A brief explanation of why this agent was chosen."),
});

// Helper function to parse orchestrator response
function parseOrchestratorResponse(response: any): { agent_to_invoke: string; reasoning: string } {
  // If response is already in the correct format, return it
  if (response && typeof response.agent_to_invoke === 'string' && typeof response.reasoning === 'string') {
    return response;
  }

  // If response is a string, try to parse it as JSON
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response);
      if (parsed && typeof parsed.agent_to_invoke === 'string') {
        return {
          agent_to_invoke: parsed.agent_to_invoke,
          reasoning: parsed.reasoning || 'No reasoning provided'
        };
      }
    } catch (e) {
      // If parsing fails, continue to fallback
    }
  }

  // Fallback to default response
  return {
    agent_to_invoke: 'short_response',
    reasoning: 'Defaulting to short_response due to invalid response format'
  };
}

/**
 * Formats an array of BaseMessage objects into a string for the prompt.
 */
const formatMessagesForPrompt = (messages: BaseMessage[]): string => {
  return messages.map(m => `${m._getType()}: ${m.content}`).join('\n');
};

/**
 * The GraphService is responsible for building and running the conversational agent graph.
 */
class GraphService {
  private graph: StateGraph<GraphState>;

  constructor() {
    this.graph = new StateGraph({
      channels: {
        user: { value: null },
        messages: { value: (x, y) => x.concat(y), default: () => [] },
        nextAgent: { value: null },
        agentOutcome: { value: null },
        lastAgent: { value: null },
        userMessage: { value: null }, // Add userMessage channel
      },
    });
  }

  /**
   * Dynamically loads all active prompts from the database and compiles them into
   * executable agent runnables.
   */
  async loadAgentsFromDb() {
    logger.info('Loading dynamic agents from database...');
    const prompts = await prisma.prompt.findMany({ where: { isActive: true } });

    for (const prompt of prompts) {
      try {
        const promptTemplate = ChatPromptTemplate.fromMessages([
          ['system', prompt.systemMessage],
          ['user', '{input}'],
        ]);
        
        if (prompt.promptType === 'orchestrator') {
          // FIX: Construir la cadena del orquestador correctamente
          const client = await llmManager.getLLMClient({
            temperature: 0.2,
            maxTokens: 4096,
          });

          // Adjuntar las instrucciones de formato JSON al final del system message
          const orchestratorPrompt = ChatPromptTemplate.fromMessages([
            ['system', prompt.systemMessage + '\n\nTu respuesta DEBE ser un objeto JSON válido que siga este esquema:\n{schema}\n\nResponde ÚNICAMENTE con el JSON.'],
            ['user', '{user_message}']
          ]);
          
          const parser = new JsonOutputParser();
          
          // La cadena final es Prompt -> LLM -> Parser
          agentRunnables[prompt.promptType] = orchestratorPrompt
            .pipe(client)
            .pipe(parser)
            .withConfig({ runName: 'OrchestratorChain' });

        } else {
          // For regular agents, use standard client
          const model = await llmManager.getLLMClient({
            temperature: 0.2,
            maxTokens: 4096,
          });
          
          // For agents that need tools, check if the model supports tools
          if (['onboarding', 'meta_query', 'customer_service'].includes(prompt.promptType) && 
              typeof model.bindTools === 'function') {
            try {
              const modelWithTools = model.bindTools(allTools);
              agentRunnables[prompt.promptType] = promptTemplate.pipe(modelWithTools);
              logger.debug(`Bound tools to agent: ${prompt.promptType}`);
            } catch (toolError) {
              logger.warn(`Failed to bind tools to ${prompt.promptType}, falling back to model without tools:`, toolError);
              agentRunnables[prompt.promptType] = promptTemplate.pipe(model);
            }
          } else {
            // If tools are not supported or not needed, use the model as is
            agentRunnables[prompt.promptType] = promptTemplate.pipe(model);
            if (['onboarding', 'meta_query', 'customer_service'].includes(prompt.promptType)) {
              logger.warn(`Model does not support tools, running ${prompt.promptType} without tools`);
            }
          }
        }
        
        logger.debug(`Loaded agent: ${prompt.promptType} (${prompt.persona})`);
      } catch (error) {
        logger.error(`Failed to load agent ${prompt.promptType}:`, error);
        throw error;
      }
    }
    logger.info(`Successfully loaded ${prompts.length} agents.`);
  }

  /**
   * Builds the graph structure, defining nodes and their connections.
   */
  buildGraph() {
    this.graph
      .addNode('orchestrator', this.runOrchestrator.bind(this))
      .addNode('daily_practice_A0', this.runAgentNode.bind(this))
      .addNode('daily_practice_A1_A2', this.runAgentNode.bind(this))
      .addNode('daily_practice_B1', this.runAgentNode.bind(this))
      .addNode('daily_practice_B2', this.runAgentNode.bind(this))
      .addNode('daily_practice_C1_C2', this.runAgentNode.bind(this))
      .addNode('onboarding', this.runAgentNode.bind(this))
      .addNode('meta_query', this.runAgentNode.bind(this))
      .addNode('short_response', this.runAgentNode.bind(this))
      .addNode('customer_service', this.runAgentNode.bind(this))
      .addNode('text_summary', this.runAgentNode.bind(this))
      .addNode('error_handler', this.runErrorHandler.bind(this));

    this.graph.setEntryPoint('orchestrator');

    this.graph.addConditionalEdges('orchestrator', this.routeFromOrchestrator, {
      daily_practice_A0: 'daily_practice_A0',
      daily_practice_A1_A2: 'daily_practice_A1_A2',
      daily_practice_B1: 'daily_practice_B1',
      daily_practice_B2: 'daily_practice_B2',
      daily_practice_C1_C2: 'daily_practice_C1_C2',
      onboarding: 'onboarding',
      meta_query: 'meta_query',
      short_response: 'short_response',
      customer_service: 'customer_service',
      text_summary: 'text_summary',
      error_handler: 'error_handler',
      __end__: END,
    });

    // All worker nodes should end the graph
    this.graph.addEdge('daily_practice_A0', END);
    this.graph.addEdge('daily_practice_A1_A2', END);
    this.graph.addEdge('daily_practice_B1', END);
    this.graph.addEdge('daily_practice_B2', END);
    this.graph.addEdge('daily_practice_C1_C2', END);
    this.graph.addEdge('onboarding', END);
    this.graph.addEdge('meta_query', END);
    this.graph.addEdge('short_response', END);
    this.graph.addEdge('customer_service', END);
    this.graph.addEdge('text_summary', END);
    this.graph.addEdge('error_handler', END);
    
    return this.graph.compile();
  }

  /**
   * The orchestrator node decides the next agent.
   */
private async runOrchestrator(state: GraphState): Promise<Partial<GraphState>> {
  const { messages, user, userMessage } = state;
  const orchestrator = agentRunnables['orchestrator'];
  
  if (!orchestrator) {
    const errorMessage = 'Critical Error: Orchestrator agent not loaded.';
    tracer.error('Orchestrator', errorMessage);
    return { nextAgent: 'error_handler', agentOutcome: errorMessage, lastAgent: 'orchestrator' };
  }

  try {
    const chatHistory = formatMessagesForPrompt(messages.slice(0, -1));
    const currentMessage = userMessage || (messages.length > 0 ? messages[messages.length - 1]?.content : '') || '';
    
    // FIX: Preparar un input limpio para el prompt
    const orchestratorInput = {
      // --- Variables principales para el prompt refactorizado ---
      user_message: currentMessage,
      chat_history: chatHistory,
      schema: JSON.stringify(orchestratorSchema.parameters || orchestratorSchema, null, 2),

      // --- Variables para compatibilidad con tu prompt actual en la DB ---
      user_profile: JSON.stringify({
        firstName: user.firstName,
        cefrLevel: user.cefrLevel,
        interests: user.interests,
        learningGoal: user.learningGoal,
        isOnboarding: user.isOnboarding,
        onboardingStep: user.onboardingStep
      }, null, 2),
      workflow_status: user.onboardingStep || 'not in workflow',
      user_cefr_level: user.cefrLevel || 'not specified',
      // También agregamos otras variables que podrías tener en tu prompt
      cefrLevel: user.cefrLevel || 'not specified',
      studentName: user.firstName || 'student',
      firstName: user.firstName || 'student',
      interests: user.interests?.join(', ') || 'not specified',
      learningGoal: user.learningGoal || 'not specified',
    };

    logger.debug('Orchestrator input prepared', orchestratorInput);
    
    let response;
    try {
      // La invocación ahora es mucho más simple
      const rawResponse = await orchestrator.invoke(orchestratorInput);
      response = parseOrchestratorResponse(rawResponse); // Tu función de parseo sigue siendo útil
      logger.debug('Orchestrator response:', response);
    } catch (error) {
      logger.error('Error invoking or parsing orchestrator response:', error);
      // El error original que veías se captura aquí
      throw new Error(`Failed to process orchestrator response: ${error.message}`);
    }
    
    tracer.decision('Orchestrator', { 
      decision: response.agent_to_invoke, 
      reasoning: response.reasoning 
    });
    
    let agentToInvoke = response.agent_to_invoke?.toLowerCase().trim();
    
    if (agentToInvoke === 'daily_practice' || agentToInvoke?.startsWith('daily_practice_')) {
      const level = user.cefrLevel?.toUpperCase();
      if (level === 'A0') agentToInvoke = 'daily_practice_A0';
      else if (level === 'A1' || level === 'A2') agentToInvoke = 'daily_practice_A1_A2';
      else if (level === 'B1') agentToInvoke = 'daily_practice_B1';
      else if (level === 'B2') agentToInvoke = 'daily_practice_B2';
      else if (level === 'C1' || level === 'C2') agentToInvoke = 'daily_practice_C1_C2';
      else agentToInvoke = 'daily_practice_A1_A2';
    }
    
    if (agentToInvoke && agentRunnables[agentToInvoke]) {
      return { 
        nextAgent: agentToInvoke, 
        lastAgent: 'orchestrator',
        agentOutcome: `Routing to ${agentToInvoke}: ${response.reasoning}`
      };
    } else {
      const availableAgents = Object.keys(agentRunnables).join(', ');
      const errorMessage = `Invalid agent selected: '${agentToInvoke}'. Available agents: ${availableAgents}`;
      logger.warn(errorMessage);
      return { 
        nextAgent: 'error_handler', 
        agentOutcome: errorMessage,
        lastAgent: 'orchestrator'
      };
    }
  } catch (error) {
    const errorMessage = `Orchestrator execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    tracer.error('Orchestrator', errorMessage);
    logger.error('Orchestrator error:', { error, stack: error.stack }); // Loguea el stack para mejor depuración
    return { 
      nextAgent: 'error_handler', 
      agentOutcome: errorMessage,
      lastAgent: 'orchestrator'
    };
  }
}

  /**
   * A generic node for running worker agents.
   */
  private async runAgentNode(state: GraphState): Promise<Partial<GraphState>> {
    const { messages, nextAgent, user, userMessage } = state;
    const agent = agentRunnables[nextAgent];

    if (!agent) {
      const errorMessage = `Agent '${nextAgent}' not found`;
      tracer.error('AgentNode', errorMessage);
      return { 
        agentOutcome: errorMessage, 
        lastAgent: nextAgent,
        messages: [new AIMessage("I'm sorry, I encountered a technical issue. Please try again.")]
      };
    }

    tracer.route('Orchestrator', nextAgent);
    
    try {
      // Prepare comprehensive input for the agent
      const chatHistory = formatMessagesForPrompt(messages.slice(0, -1));
      const currentMessage = userMessage || messages[messages.length - 1]?.content || '';
      
      const agentInput = {
        input: currentMessage,
        firstName: user.firstName,
        studentName: user.firstName,
        onboardingStep: user.onboardingStep,
        cefrLevel: user.cefrLevel,
        interests: user.interests || [],
        learningGoal: user.learningGoal,
        userProfile: JSON.stringify(user, null, 2),
        user_profile: JSON.stringify(user, null, 2),
        user_message: currentMessage,
        chat_history: chatHistory,
        user_query: currentMessage,
        evaluationJson: {} // Placeholder for evaluation data
      };

      logger.debug(`${nextAgent} input:`, agentInput);

      const response = await agent.invoke(agentInput);
      
      let responseContent: string;
      
      // Handle different response formats
      if (typeof response === 'string') {
        responseContent = response;
      } else if (response && typeof response === 'object') {
        if ('content' in response) {
          responseContent = response.content;
        } else if ('text' in response) {
          responseContent = response.text;
        } else {
          responseContent = JSON.stringify(response);
        }
      } else {
        responseContent = "I'm processing your request...";
      }

      tracer.agentResponse(nextAgent, responseContent);

      return {
        messages: [new AIMessage(responseContent)],
        agentOutcome: responseContent,
        lastAgent: nextAgent,
      };
    } catch (error) {
      const errorMessage = `Agent '${nextAgent}' execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      tracer.error(nextAgent, errorMessage);
      logger.error(`Agent ${nextAgent} error:`, error);
      
      return { 
        agentOutcome: "I'm sorry, I encountered a technical issue. Please try again.",
        lastAgent: nextAgent,
        messages: [new AIMessage("I'm sorry, I encountered a technical issue. Please try again.")]
      };
    }
  }

  private runErrorHandler(state: GraphState): Partial<GraphState> {
    const errorMessage = state.agentOutcome as string || 'An unknown error occurred in the graph.';
    tracer.error('Graph', errorMessage);
    const finalMessage = new AIMessage("I'm sorry, I encountered a technical issue. Please try again in a moment.");
    return { 
      messages: [finalMessage], 
      agentOutcome: finalMessage.content,
      lastAgent: 'error_handler'
    };
  }

  /**
   * The routing logic that directs the conversation after the orchestrator runs.
   */
  private routeFromOrchestrator(state: GraphState): string {
    return state.nextAgent || 'error_handler';
  }
}

export const graphService = new GraphService();