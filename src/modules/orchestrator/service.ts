import { OpenAI } from 'openai';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { logger, logUserAction, logApiCall } from '../../utils/logger.js';
import { FeedbackResponse, EvaluationResponse, User, Platform } from '../../types/index.js';
import { userService } from '../users/service.js';
import { createError } from '../../middleware/errorHandler.js';
import env from '../../config/environment.js';
import prisma from '../../config/database.js';
import { s3Client } from '../../config/s3.js';
import { onboardingService } from '../onboarding/service.js';

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: env.OPENAI_API_TIMEOUT
});

/**
 * Main orchestrator service that coordinates all user interactions using a Dynamic Agent Routing & Response (DARR) model.
 */
export class OrchestratorService {
  private readonly baseURL = env.API_BASE_URL;
  private readonly internalApiKey = env.INTERNAL_API_KEY;

  /**
   * Handles incoming user message, determines intent via a router agent, and delegates to the appropriate specialist agent.
   */
  async handleUserMessage(
    userId: string,
    inputType: 'text' | 'audio',
    content: string, // Text message or file path to audio
    platform: Platform,
    messageData: any
  ): Promise<any> {
    const startTime = Date.now();
    
    try {
      logUserAction(userId, 'message_received', { platform, inputType });

      const user = await userService.getUserById(userId);
      if (!user) throw createError(`User not found: ${userId}`, 404);

      // If user is in onboarding, delegate to the specialized onboarding service.
      if (user.isOnboarding) {
        return onboardingService.processOnboardingStep(user.id, content, user.onboardingStep, platform);
      }

      const textInput = inputType === 'audio' ? await this._transcribeAudio(content, user.id) : content;
      
      // Persist user's message to chat history
      await this._saveToChatHistory(user.id, 'user', textInput);

      // --- DYNAMIC AGENT ROUTING ---
      const agentToInvoke = await this._runOrchestratorAgent(user, textInput);
      logUserAction(userId, 'agent_route_decision', { decision: agentToInvoke });

      let response;
      switch (agentToInvoke) {
        case 'practice_session_agent':
          response = await this._processPracticeSession(user, inputType, content, textInput, platform);
          break;
        case 'meta_query_agent':
          response = await this._handleMetaQuery(user, textInput, platform);
          break;
        case 'customer_service_agent':
          response = await this._handleCustomerServiceQuery(user, textInput, platform);
          break;
        default:
          logger.warn(`Unknown agent decision: '${agentToInvoke}'. Defaulting to practice session.`);
          response = await this._processPracticeSession(user, inputType, content, textInput, platform);
      }
      
      // Persist agent's final response to chat history
      const agentResponseText = response.textSummary || response.text;
      if (agentResponseText) {
        await this._saveToChatHistory(user.id, 'assistant', agentResponseText, agentToInvoke);
      }

      return response;

    } catch (error) {
      logger.error('Critical error in DARR orchestrator service:', {
        userId, platform, error: error instanceof Error ? error.message : 'Unknown error',
      });
      await this._sendContextualErrorMessage(userId, platform);
      throw error;
    }
  }

  /**
   * Runs the master router agent to decide which specialist agent to use.
   */
  private async _runOrchestratorAgent(user: User, textInput: string): Promise<string> {
    const agentManifest = this._getAgentManifest();
    const chatHistory = await this._getChatHistory(user.id);
    
    const routerPrompt = await this._getPrompt('all', 'orchestrator', 'router');
    if (!routerPrompt) throw new Error("Orchestrator router prompt not found!");

    const systemMessage = routerPrompt.systemMessage
      .replace('{{agent_manifest}}', JSON.stringify(agentManifest, null, 2));

    const userMessage = `
Conversation History:
${chatHistory.map(h => `${h.role}: ${h.content}`).join('\n')}

Latest User Message: "${textInput}"`;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [{ role: "system", content: systemMessage }, { role: "user", content: userMessage }],
        response_format: { type: "json_object" },
        temperature: 0.1,
      });

      const jsonResponse = JSON.parse(completion.choices[0].message.content || '{}');
      return jsonResponse.agent_to_invoke || 'practice_session_agent';
    } catch (error) {
      logger.error("Failed to run orchestrator agent, defaulting to practice session", { error });
      return 'practice_session_agent';
    }
  }

  /**
   * Defines the available agents for the router. In a real system, this could be dynamic.
   */
  private _getAgentManifest() {
    return [
      {
        agent_name: "practice_session_agent",
        description: "Invoke for English practice sessions, general conversation, or when the user sends a voice message to practice. This is the default agent."
      },
      {
        agent_name: "meta_query_agent",
        description: "Invoke when the user asks about their profile, progress, level, or how the app works. Examples: 'what is my level?', 'how many points do I have?'"
      },
      {
        agent_name: "customer_service_agent",
        description: "Invoke for questions about subscriptions, payments, technical problems, or if the user expresses frustration with the service. Examples: 'my payment failed', 'I want to cancel my account'."
      }
    ];
  }

  /**
   * Process a standard practice session.
   */
  private async _processPracticeSession(user: User, inputType: 'text' | 'audio', originalContent: string, textToEvaluate: string, platform: string) {
    const wordCount = this._countWords(textToEvaluate);
    if (wordCount < env.EVALUATOR_MIN_WORD_COUNT) {
      return this._handleShortResponse(user, platform);
    }

    const evaluation = await this._evaluateWithAgent(textToEvaluate, user.cefrLevel, user.id);
    const [teacherPrompt, summaryPrompt] = await this._getPromptsWithFallback(user.cefrLevel, 'teacher_feedback', 'text_summary');
    
    const [audioFeedbackUrl, textSummary] = await this._generateFeedbackResilient(
      teacherPrompt.systemMessage, summaryPrompt.systemMessage, textToEvaluate, evaluation, user
    );

    const xpEarned = this._calculateXp(evaluation.overall, user.cefrLevel);

    const session = await prisma.$transaction(async (tx) => {
      const createdSession = await tx.session.create({
        data: {
          userId: user.id, userInput: originalContent, transcription: textToEvaluate, inputType,
          evaluationJson: evaluation, overallScore: evaluation.overall, pronunciation: evaluation.pronunciation,
          fluency: evaluation.fluency, grammar: evaluation.grammar, vocabulary: evaluation.vocabulary,
          feedbackAudioUrl: audioFeedbackUrl, feedbackText: textSummary, sessionType: 'practice',
          xpEarned, wordsSpoken: wordCount
        }
      });
      await this._updateUserProgressInTransaction(tx, user.id, xpEarned);
      return createdSession;
    });

    setImmediate(() => this._sendFeedbackToUser(user.id, platform, audioFeedbackUrl, textSummary));
    setImmediate(() => this._checkLevelUpEligibility(user.id));

    logUserAction(user.id, 'practice_session_completed', { sessionId: session.id, score: evaluation.overall, xpEarned });
    return { audioUrl: audioFeedbackUrl, textSummary, xpEarned, levelUp: false };
  }

  /**
   * Handles meta-queries like "what is my level?".
   */
  private async _handleMetaQuery(user: User, query: string, platform: Platform) {
    const agentPrompt = await this._getPrompt('all', 'meta_query', 'assistant');
    if (!agentPrompt) throw new Error("Meta query agent prompt not found.");

    const userProfileJson = JSON.stringify({
      firstName: user.firstName, cefrLevel: user.cefrLevel, xp: user.xp, streak: user.streak
    });

    const systemMessage = agentPrompt.systemMessage;
    const userMessage = `Data: ${userProfileJson}\nUser Query: "${query}"`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: systemMessage }, { role: "user", content: userMessage }],
      max_tokens: 100,
    });
    const responseText = completion.choices[0].message.content || "I couldn't find that information right now.";
    
    await this._sendSimpleMessage(user.id, platform, responseText);
    return { text: responseText };
  }

  /**
   * Handles customer service related queries.
   */
  private async _handleCustomerServiceQuery(user: User, query: string, platform: Platform) {
    const agentPrompt = await this._getPrompt('all', 'customer_service', 'support');
    if (!agentPrompt) throw new Error("Customer service agent prompt not found.");

    const chatHistory = await this._getChatHistory(user.id);
    const userProfileJson = JSON.stringify({ firstName: user.firstName, email: user.email }); // Assuming email exists

    const systemMessage = agentPrompt.systemMessage;
    const userMessage = `
User Profile: ${userProfileJson}
Conversation History:
${chatHistory.map(h => `${h.role}: ${h.content}`).join('\n')}
Latest User Message: "${query}"`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "system", content: systemMessage }, { role: "user", content: userMessage }],
      max_tokens: 150,
    });
    const responseText = completion.choices[0].message.content || "I'm sorry, I can't assist with that right now, but I've notified our team.";
    
    await this._sendSimpleMessage(user.id, platform, responseText);
    return { text: responseText };
  }

  // --- Helper and Utility Methods ---

  private async _handleShortResponse(user: User, platform: Platform) {
    const agentPrompt = await this._getPrompt('all', 'short_response', 'coach');
    if (!agentPrompt) {
      logger.error('Short response agent prompt not found.');
      await this._sendSimpleMessage(user.id, platform, "Please try saying a bit more.");
      return { text: "Please try saying a bit more." };
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: agentPrompt.systemMessage }],
      max_tokens: 50,
    });
    const responseText = completion.choices[0].message.content || "Can you tell me more?";
    
    await this._sendSimpleMessage(user.id, platform, responseText);
    return { text: responseText };
  }

  private async _transcribeAudio(audioFilePath: string, userId: string): Promise<string> {
    // This remains a placeholder for actual file handling from a gateway
    if (process.env.NODE_ENV !== 'production') {
        return "This is a test transcription for my practice session about technology and movies.";
    }
    throw new Error('Real audio transcription not implemented.');
  }

  private async _evaluateWithAgent(textToEvaluate: string, userLevel: string, userId: string): Promise<EvaluationResponse> {
    const agentPrompt = await this._getPrompt(userLevel, 'speech_evaluation', 'evaluator');
    if (!agentPrompt) throw new Error('Speech evaluation agent prompt not found.');
    const userMessage = `Student CEFR Level: ${userLevel}\nText to evaluate: "${textToEvaluate}"`;
    
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [{ role: "system", content: agentPrompt.systemMessage }, { role: "user", content: userMessage }],
        response_format: { type: "json_object" }, temperature: 0.2,
      });
      return JSON.parse(completion.choices[0].message.content || '{}');
    } catch (error) {
      logger.error('Evaluation with agent failed, using fallback.', { userId, error });
      return { overall: 70, pronunciation: 70, fluency: 70, grammar: 70, vocabulary: 70, feedback: { overall: "Evaluation failed, but practice was saved." } };
    }
  }

  private async _getPromptsWithFallback(level: string, teacherType: string, summaryType: string) {
    const [teacherResponse, summaryResponse] = await Promise.allSettled([
      this._getPrompt(level, teacherType, 'alex'),
      this._getPrompt(level, summaryType, 'reporter')
    ]);
    const teacherPrompt = teacherResponse.status === 'fulfilled' && teacherResponse.value ? teacherResponse.value : { systemMessage: "You are Alex, a friendly AI English teacher." };
    const summaryPrompt = summaryResponse.status === 'fulfilled' && summaryResponse.value ? summaryResponse.value : { systemMessage: "You are a reporter. Provide a concise summary." };
    return [teacherPrompt, summaryPrompt];
  }

  private async _generateFeedbackResilient(teacherSystemPrompt: string, summarySystemPrompt: string, textToEvaluate: string, evaluation: EvaluationResponse, user: any) {
    const [audioResult, summaryResult] = await Promise.allSettled([
      this._generateAudioFeedback(teacherSystemPrompt, textToEvaluate, evaluation, user),
      this._generateTextSummary(summarySystemPrompt, textToEvaluate, evaluation, user)
    ]);
    const audioFeedbackUrl = audioResult.status === 'fulfilled' ? audioResult.value : undefined;
    const textSummary = summaryResult.status === 'fulfilled' ? summaryResult.value : `¡Buen trabajo! Puntuación: ${evaluation.overall}/100.`;
    return [audioFeedbackUrl, textSummary];
  }

  private async _generateAudioFeedback(systemPrompt: string, textToEvaluate: string, evaluation: EvaluationResponse, user: any): Promise<string> {
    const feedbackText = await this._generateFeedbackText(systemPrompt, textToEvaluate, evaluation, user);
    const speechResponse = await openai.audio.speech.create({ model: "tts-1", voice: "alloy", input: feedbackText, speed: 0.95 });
    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
    return this._uploadAudioToStorage(audioBuffer, user.id);
  }

  private async _uploadAudioToStorage(audioBuffer: Buffer, userId: string): Promise<string> {
    const key = `feedback/${userId}/${uuidv4()}.mp3`;
    const bucket = env.AWS_S3_BUCKET;
    const command = new PutObjectCommand({ Bucket: bucket, Key: key, Body: audioBuffer, ContentType: 'audio/mpeg', ACL: 'public-read' });
    await s3Client.send(command);
    return env.S3_ENDPOINT ? `${env.S3_ENDPOINT}/${bucket}/${key}` : `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
  }

  private async _generateFeedbackText(systemPrompt: string, textToEvaluate: string, evaluation: EvaluationResponse, user: any): Promise<string> {
    const userPrompt = `Student's input: "${textToEvaluate}"\nEvaluation (JSON): ${JSON.stringify(evaluation, null, 2)}`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], max_tokens: 200,
    });
    return completion.choices[0].message.content || "Great job practicing!";
  }

  private async _generateTextSummary(systemPrompt: string, textToEvaluate: string, evaluation: EvaluationResponse, user: any): Promise<string> {
    const userPrompt = `Student's input: "${textToEvaluate}"\nEvaluation (JSON): ${JSON.stringify(evaluation, null, 2)}`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], max_tokens: 150,
    });
    return completion.choices[0].message.content || "¡Buen trabajo!";
  }

  private _calculateXp(score: number, userLevel: string): number {
    const levelMultipliers: { [key: string]: number } = { 'A0': 1, 'A1': 1.1, 'A2': 1.2, 'B1': 1.3, 'B2': 1.4, 'C1': 1.5, 'C2': 1.6 };
    return Math.round(10 * Math.max(0.5, score / 50) * (levelMultipliers[userLevel] || 1));
  }

  private async _sendContextualErrorMessage(userId: string, platform: string) {
    await this._sendSimpleMessage(userId, platform, "Lo siento, estamos teniendo problemas técnicos. Por favor, inténtalo de nuevo en unos minutos. 🔧");
  }

  private async _sendSimpleMessage(userId: string, platform: string, text: string) {
    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, { userId, platform, text }, { headers: { 'x-api-key': this.internalApiKey }});
    } catch (error) {
      logger.error('Failed to send simple message', { userId, error });
    }
  }

  private async _getPrompt(level: string, type: string, persona: string) {
    const id = `${level}-${type}-${persona}`;
    let prompt = await prisma.prompt.findUnique({ where: { id } });
    if (!prompt) {
      const fallbackId = `all-${type}-${persona}`;
      prompt = await prisma.prompt.findUnique({ where: { id: fallbackId } });
    }
    return prompt;
  }

  private async _updateUserProgressInTransaction(tx: any, userId: string, xpEarned: number) {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found in transaction');
    const now = new Date();
    const daysDiff = Math.floor((now.getTime() - new Date(user.lastActivity).getTime()) / (1000 * 60 * 60 * 24));
    const newStreak = (daysDiff === 1) ? user.streak + 1 : (daysDiff > 1 ? 1 : user.streak);
    await tx.user.update({ where: { id: userId }, data: { xp: { increment: xpEarned }, streak: newStreak, lastActivity: now } });
  }

  private async _sendFeedbackToUser(userId: string, platform: string, audioUrl: string | undefined, textSummary: string) {
    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, { userId, platform, audioUrl, text: textSummary }, { headers: { 'x-api-key': this.internalApiKey }});
    } catch (error) {
      logger.error('Error sending feedback to user:', { userId, platform, error });
    }
  }

  private async _checkLevelUpEligibility(userId: string) {
    logger.info('Placeholder: Checking level up eligibility', { userId });
  }

  private _countWords(text: string): number {
    return text?.trim().split(/\s+/).filter(Boolean).length || 0;
  }

  private async _getChatHistory(userId: string, limit = 10) {
    return prisma.chatHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  private async _saveToChatHistory(userId: string, role: 'user' | 'assistant', content: string, agentName?: string) {
    await prisma.chatHistory.create({
      data: { userId, role, content, agentName },
    });
  }
}

export const orchestratorService = new OrchestratorService();
