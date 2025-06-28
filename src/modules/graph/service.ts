import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { StateGraph, END } from '@langchain/langgraph';
import { Runnable } from '@langchain/core/runnables';
import { z } from 'zod';
import prisma from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { tracer } from '../../utils/tracer.js';
import { User } from '../../types/index.js';
import env from '../../config/environment.js';

/**
 * Defines the state that flows through the graph.
 * Each node can modify this state.
 */
interface GraphState {
  user: User;
  messages: BaseMessage[];
  nextAgent: string;
  agentOutcome: string | object;
  lastAgent: string; // FIX: Add explicit tracking for the agent that just ran
}

/**
 * A map to hold our dynamically loaded agent runnables.
 */
const agentRunnables: Record<string, Runnable> = {};

/**
 * Defines the JSON schema for the orchestrator's output.
 * This ensures the LLM returns data in a predictable structure.
 */
const orchestratorSchema = z.object({
  agent_to_invoke: z.string().describe("The name of the agent to invoke next (e.g., 'onboarding', 'daily_practice', 'meta_query')."),
  reasoning: z.string().describe("A brief explanation of why this agent was chosen."),
});

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
        lastAgent: { value: null }, // FIX: Add channel for lastAgent
      },
    });
  }

  /**
   * Dynamically loads all active prompts from the database and compiles them into
   * executable agent runnables. This is the core of our dynamic architecture.
   */
  async loadAgentsFromDb() {
    logger.info('Loading dynamic agents from database...');
    const prompts = await prisma.prompt.findMany({ where: { isActive: true } });

    for (const prompt of prompts) {
      const model = new ChatOpenAI({
        modelName: 'gpt-4-turbo',
        temperature: 0.2,
        apiKey: env.OPENAI_API_KEY,
      });
      
      // The user-facing prompts are now complex and contain examples with JSON.
      // We must escape all curly braces in the system message to prevent LangChain's
      // prompt formatter from misinterpreting them as variables.
      const escapedSystemMessage = prompt.systemMessage.replace(/{/g, '{{').replace(/}/g, '}}');

      const promptTemplate = ChatPromptTemplate.fromMessages([
        ['system', escapedSystemMessage],
        ['user', '{input}'],
      ]);
      
      if (prompt.promptType === 'orchestrator') {
        const structuredLLM = model.withStructuredOutput(orchestratorSchema, {
          method: "tool_calling",
        });
        agentRunnables[prompt.promptType] = promptTemplate.pipe(structuredLLM);
      } else {
        agentRunnables[prompt.promptType] = promptTemplate.pipe(model);
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
      .addNode('daily_practice', this.runAgentNode.bind(this))
      .addNode('onboarding', this.runAgentNode.bind(this))
      .addNode('meta_query', this.runAgentNode.bind(this))
      .addNode('short_response', this.runAgentNode.bind(this))
      .addNode('customer_service', this.runAgentNode.bind(this))
      .addNode('text_summary', this.runAgentNode.bind(this))
      .addNode('error_handler', this.runErrorHandler.bind(this));

    this.graph.setEntryPoint('orchestrator');

    this.graph.addConditionalEdges('orchestrator', this.routeFromOrchestrator, {
      daily_practice: 'daily_practice',
      onboarding: 'onboarding',
      meta_query: 'meta_query',
      short_response: 'short_response',
      customer_service: 'customer_service',
      text_summary: 'text_summary',
      error_handler: 'error_handler',
      __end__: END,
    });

    // All worker nodes should end the graph for now.
    this.graph.addEdge('daily_practice', END);
    this.graph.addEdge('onboarding', END);
    this.graph.addEdge('meta_query', END);
    this.graph.addEdge('short_response', END);
    this.graph.addEdge('customer_service', END);
    this.graph.addEdge('text_summary', END);
    this.graph.addEdge('error_handler', END);
    
    return this.graph.compile();
  }

  /**
   * The orchestrator node. It decides the next agent AND validates its existence.
   */
  private async runOrchestrator(state: GraphState): Promise<Partial<GraphState>> {
    const { messages, user } = state;
    const orchestrator = agentRunnables['orchestrator'];
    if (!orchestrator) {
      const errorMessage = 'Critical Error: Orchestrator agent itself is not loaded.';
      tracer.error('Orchestrator', errorMessage);
      return { nextAgent: 'error_handler', agentOutcome: errorMessage, lastAgent: 'orchestrator' };
    }

    // FIX: Pass the full conversation history to the orchestrator prompt
    const input = formatMessagesForPrompt(messages);

    const response = await orchestrator.invoke({ 
      input,
      // Pass other variables defined in the prompt
      firstName: user.firstName,
      user_message: messages[messages.length - 1].content,
      chat_history: formatMessagesForPrompt(messages.slice(0, -1)),
      workflow_status: user.onboardingStep,
      user_cefr_level: user.cefrLevel,
      studentName: user.firstName,
      cefrLevel: user.cefrLevel,
      onboardingStep: user.onboardingStep,
      interests: user.interests?.join(', ') || 'not specified',
      learningGoal: user.learningGoal || 'not specified',
      userProfile: JSON.stringify(user, null, 2),
      user_profile: JSON.stringify(user, null, 2),
    }) as { agent_to_invoke: string; reasoning: string };
    
    tracer.decision('Orchestrator', { 
      decision: `LLM wants to invoke: ${response.agent_to_invoke}`, 
      reasoning: response.reasoning 
    });
    
    const agentToInvoke = response.agent_to_invoke;
    if (agentRunnables[agentToInvoke]) {
      return { nextAgent: agentToInvoke, lastAgent: 'orchestrator' };
    } else {
      const errorMessage = `Orchestrator picked an invalid or unloaded agent: '${agentToInvoke}'.`;
      tracer.error('Orchestrator', errorMessage);
      return { 
        nextAgent: 'error_handler', 
        agentOutcome: errorMessage,
        lastAgent: 'orchestrator'
      };
    }
  }

  /**
   * A generic node for running worker agents. It now assumes the agent exists.
   */
  private async runAgentNode(state: GraphState): Promise<Partial<GraphState>> {
    const { messages, nextAgent, user } = state;
    const agent = agentRunnables[nextAgent];

    tracer.route('Orchestrator', nextAgent);
    
    // FIX: Pass the full conversation history to the agent's prompt
    const input = formatMessagesForPrompt(messages);

    const response = await agent.invoke({ 
      input,
      // Pass other common variables agents might need
      firstName: user.firstName,
      studentName: user.firstName,
      onboardingStep: user.onboardingStep,
      cefrLevel: user.cefrLevel,
      interests: user.interests,
      learningGoal: user.learningGoal,
      userProfile: JSON.stringify(user),
      // Add more variables as needed by different prompts
    });
    tracer.agentResponse(nextAgent, response.content as string);

    return {
      messages: [new AIMessage(response.content)],
      agentOutcome: response.content,
      lastAgent: nextAgent, // FIX: Explicitly set the agent that just ran
    };
  }

  private runErrorHandler(state: GraphState): Partial<GraphState> {
    const errorMessage = state.agentOutcome as string || 'An unknown error occurred in the graph.';
    tracer.error('Graph', errorMessage);
    const finalMessage = new AIMessage("I'm sorry, I encountered a technical issue. Please try again in a moment.");
    return { 
      messages: [finalMessage], 
      agentOutcome: finalMessage.content,
      lastAgent: 'error_handler' // FIX: Set lastAgent for error handler
    };
  }

  /**
   * The routing logic that directs the conversation after the orchestrator runs.
   */
  private routeFromOrchestrator(state: GraphState): string {
    return state.nextAgent;
  }
}

export const graphService = new GraphService();
