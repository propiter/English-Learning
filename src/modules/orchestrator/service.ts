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
 * Main orchestrator service that coordinates all user interactions
 */
export class OrchestratorService {
  private readonly baseURL = env.API_BASE_URL;
  private readonly internalApiKey = env.INTERNAL_API_KEY;
  private readonly MAX_RETRIES = 2;
  private readonly RETRY_DELAY_MS = 1500;

  /**
   * Handle incoming user message and orchestrate the complete flow
   */
  async handleUserMessage(
    userId: string,
    inputType: 'text' | 'audio',
    content: string, // Text message or file path to audio
    platform: Platform,
    messageData: any
  ): Promise<FeedbackResponse | void> {
    const startTime = Date.now();
    
    try {
      logUserAction(userId, 'message_received', { platform, inputType });

      const user = await this._fetchUserProfileWithRetry(userId);
      if (!user) {
        throw createError(`User not found: ${userId}`, 404);
      }

      if (user.isOnboarding) {
        await onboardingService.processOnboardingStep(user.id, content, user.onboardingStep, platform);
        return;
      }

      // --- Get Transcription ---
      const textInput = inputType === 'audio' ? await this._transcribeAudio(content, user.id) : content;

      // --- Intent Classification & Word Count Check ---
      const wordCount = this._countWords(textInput);
      if (wordCount < env.EVALUATOR_MIN_WORD_COUNT) {
        return this._handleShortResponse(user, platform);
      }
      
      // TODO: Implement a more robust intent classifier. For now, we assume practice.
      const intent = 'practice_session'; 

      if (intent === 'meta_query') {
        // return this._handleMetaQuery(user, textInput, platform);
      }

      // --- Default to Practice Session Flow ---
      return await this._processPracticeSession(user, inputType, content, textInput, platform, messageData);

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Critical error in orchestrator service:', {
        userId,
        platform,
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      
      await this._sendContextualErrorMessage(userId, platform, error);
      throw error;
    }
  }

  private async _fetchUserProfileWithRetry(userId: string, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const user = await userService.getUserById(userId);
        if (user) {
          logUserAction(userId, 'user_profile_fetched', { level: user.cefrLevel });
        }
        return user;
      } catch (error) {
        logger.warn(`User profile fetch attempt ${attempt} failed`, { userId, error });
        if (attempt === retries) {
          logger.error('All user profile fetch attempts failed', { userId, error });
          return null;
        }
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS * attempt));
      }
    }
    return null;
  }

  /**
   * Process practice session using an agent-driven, resilient flow.
   */
  private async _processPracticeSession(user: User, inputType: 'text' | 'audio', originalContent: string, textToEvaluate: string, platform: string, messageData: any) {
    try {
      // --- STEP 1: PREPARE DATA (External API Calls & Slow Operations) ---
      const evaluation = await this._evaluateWithAgent(textToEvaluate, user.cefrLevel, user.id);
      
      const [teacherPrompt, summaryPrompt] = await this._getPromptsWithFallback(user.cefrLevel);

      const [audioFeedbackUrl, textSummary] = await this._generateFeedbackResilient(
        teacherPrompt.systemMessage, 
        summaryPrompt.systemMessage,
        textToEvaluate, 
        evaluation, 
        user
      );

      const xpEarned = this._calculateXp(evaluation.overall, user.cefrLevel);

      // --- STEP 2: ATOMIC DATABASE WRITE (Quick Transaction) ---
      const sessionData = {
        userId: user.id,
        userInput: originalContent,
        transcription: inputType === 'audio' ? textToEvaluate : null,
        inputType: inputType,
        evaluationJson: evaluation,
        overallScore: evaluation.overall,
        pronunciation: evaluation.pronunciation,
        fluency: evaluation.fluency,
        grammar: evaluation.grammar,
        vocabulary: evaluation.vocabulary,
        feedbackAudioUrl: audioFeedbackUrl,
        feedbackText: textSummary,
        sessionType: 'daily_practice',
        xpEarned,
        wordsSpoken: this._countWords(textToEvaluate)
      };

      const session = await prisma.$transaction(async (tx) => {
        const createdSession = await tx.session.create({ data: sessionData });
        await this._updateUserProgressInTransaction(tx, user.id, xpEarned);
        // TODO: Check for achievement unlocks here within the transaction
        return createdSession;
      });

      // --- STEP 3: POST-TRANSACTION ACTIONS (Non-blocking) ---
      setImmediate(() => this._sendFeedbackToUser(user.id, platform, audioFeedbackUrl, textSummary));
      setImmediate(() => this._checkLevelUpEligibility(user.id));

      logUserAction(user.id, 'practice_session_completed', {
        sessionId: session.id,
        score: evaluation.overall,
        xpEarned,
        platform
      });

      return {
        audioUrl: audioFeedbackUrl,
        textSummary,
        xpEarned,
        levelUp: false, // Level-up logic will be handled by its own agent
      };

    } catch (error) {
      logger.error('Practice session failed:', { userId: user.id, error });
      await this._sendPracticeErrorMessage(user.id, platform);
      return {
        audioUrl: undefined,
        textSummary: "We had a technical issue, but your practice was saved. Keep going!",
        xpEarned: 5, // Consolation XP
        levelUp: false,
      };
    }
  }

  private async _handleShortResponse(user: User, platform: Platform) {
    const agentPrompt = await this._getPrompt('all', 'short_response', 'coach');
    if (!agentPrompt) {
      logger.error('Short response agent prompt not found.');
      await this._sendSimpleMessage(user.id, platform, "Please try saying a bit more.");
      return;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "system", content: agentPrompt.systemMessage }],
      max_tokens: 50,
      temperature: 0.7
    });
    const responseText = completion.choices[0].message.content || "Can you tell me more?";
    
    await this._sendSimpleMessage(user.id, platform, responseText);
  }

  /**
   * Transcribe audio. Assumes the gateway has downloaded the file.
   */
  private async _transcribeAudio(audioFilePath: string, userId: string): Promise<string> {
    const startTime = Date.now();
    logger.warn('Audio transcription assumes a local file path. Full implementation requires file download in the gateway.', { userId, audioFilePath });
    
    if (process.env.NODE_ENV !== 'production') {
        logApiCall('openai-whisper', 'transcribe', Date.now() - startTime, true, 'dev_placeholder');
        return "I am practicing my English skills today to improve my career prospects and communicate better with international colleagues.";
    }

    // Placeholder for real transcription logic using fs.createReadStream(audioFilePath)
    logApiCall('openai-whisper', 'transcribe', Date.now() - startTime, false, 'Not implemented in this context');
    throw new Error('Real audio transcription not implemented.');
  }

  /**
   * Evaluate speech or text using an LLM agent.
   */
  private async _evaluateWithAgent(textToEvaluate: string, userLevel: string, userId: string): Promise<EvaluationResponse> {
    const startTime = Date.now();
    try {
      const agentPrompt = await this._getPrompt(userLevel, 'speech_evaluation', 'evaluator');
      if (!agentPrompt) {
        throw new Error('Speech evaluation agent prompt not found.');
      }

      const userMessage = `Student CEFR Level: ${userLevel}\nText to evaluate: "${textToEvaluate}"`;
      
      logger.info('Calling Evaluation Agent (GPT-4)', { userId });

      const completion = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [
          { role: "system", content: agentPrompt.systemMessage },
          { role: "user", content: userMessage }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      });

      const jsonResponse = completion.choices[0].message.content;
      if (!jsonResponse) {
        throw new Error('LLM returned empty content for evaluation.');
      }

      const evaluation = JSON.parse(jsonResponse) as EvaluationResponse;
      logApiCall('openai-gpt', 'evaluation-agent', Date.now() - startTime, true);
      logger.info('Received valid evaluation from agent', { userId });
      return evaluation;

    } catch (error) {
      logApiCall('openai-gpt', 'evaluation-agent', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
      logger.error('Evaluation with agent failed, using fallback.', { userId, error });
      return this._getFallbackEvaluation();
    }
  }

  private async _getPromptsWithFallback(level: string): Promise<[any, any]> {
    const [teacherResponse, summaryResponse] = await Promise.allSettled([
      this._getPrompt(level, 'teacher_feedback', 'alex'),
      this._getPrompt(level, 'text_summary', 'reporter')
    ]);

    const teacherPrompt = teacherResponse.status === 'fulfilled' && teacherResponse.value ? teacherResponse.value : { systemMessage: "You are Alex, a friendly AI English teacher. Provide encouraging feedback." };
    const summaryPrompt = summaryResponse.status === 'fulfilled' && summaryResponse.value ? summaryResponse.value : { systemMessage: "You are a reporter. Provide a concise summary in Spanish." };

    return [teacherPrompt, summaryPrompt];
  }

  private async _generateFeedbackResilient(
    teacherSystemPrompt: string,
    summarySystemPrompt: string,
    textToEvaluate: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<[string | undefined, string]> {
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
    
    const ttsStartTime = Date.now();
    const speechResponse = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: feedbackText,
      speed: 0.95
    });
    logApiCall('openai-tts', 'speech', Date.now() - ttsStartTime, true);

    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
    const audioUrl = await this._uploadAudioToStorage(audioBuffer, user.id);
    
    logUserAction(user.id, 'audio_feedback_generated', { audioUrl });
    return audioUrl;
  }

  private async _uploadAudioToStorage(audioBuffer: Buffer, userId: string): Promise<string> {
    const key = `feedback/${userId}/${uuidv4()}.mp3`;
    const bucket = env.AWS_S3_BUCKET;

    try {
      logger.info('Uploading audio to S3/Minio...', { bucket, key, size: audioBuffer.length });

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: audioBuffer,
        ContentType: 'audio/mpeg',
        ACL: 'public-read',
      });

      await s3Client.send(command);

      let publicUrl: string;
      if (env.S3_ENDPOINT) {
        const endpoint = env.S3_ENDPOINT.replace(/\/$/, '');
        publicUrl = `${endpoint}/${bucket}/${key}`;
      } else {
        publicUrl = `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
      }
      
      logger.info('Successfully uploaded audio file.', { url: publicUrl });
      return publicUrl;

    } catch (error) {
      logger.error('Failed to upload audio to S3/Minio.', { bucket, key, error });
      throw createError('Failed to upload audio file to storage.', 500);
    }
  }

  private async _generateFeedbackText(systemPrompt: string, textToEvaluate: string, evaluation: EvaluationResponse, user: any): Promise<string> {
    const userPrompt = `
Student's input: "${textToEvaluate}"
Evaluation (JSON): ${JSON.stringify(evaluation, null, 2)}
Student level: ${user.cefrLevel}
Student interests: ${user.interests?.join(', ') || 'general'}
Provide encouraging feedback as Alex, their AI English teacher.`;
    
    logger.info('Generating teacher feedback with Agent (GPT-4)', { userId: user.id });
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      max_tokens: 200,
      temperature: 0.7
    });
    return completion.choices[0].message.content || "Great job practicing! Keep up the good work!";
  }

  private async _generateTextSummary(systemPrompt: string, textToEvaluate: string, evaluation: EvaluationResponse, user: any): Promise<string> {
    const userPrompt = `
Student's input: "${textToEvaluate}"
Evaluation (JSON): ${JSON.stringify(evaluation, null, 2)}
Student level: ${user.cefrLevel}
Provide a concise summary in Spanish.`;

    logger.info('Generating text summary with Agent (GPT-4)', { userId: user.id });
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      max_tokens: 150,
      temperature: 0.6
    });
    return completion.choices[0].message.content || "¡Buen trabajo practicando!";
  }

  private _getFallbackEvaluation(): EvaluationResponse {
    return {
      overall: 70, pronunciation: 70, fluency: 70, grammar: 70, vocabulary: 70,
      feedback: {
        pronunciation: ["Could not analyze pronunciation due to a technical issue."],
        fluency: [], grammar: [], vocabulary: [],
        overall: "We had a temporary issue evaluating your speech, but your practice has been saved. Great effort!"
      }
    };
  }

  private _calculateXp(score: number, userLevel: string): number {
    let baseXP = 10;
    const scoreMultiplier = Math.max(0.5, Math.min(2, score / 50));
    const levelMultipliers: { [key: string]: number } = { 'A0': 1, 'A1': 1.1, 'A2': 1.2, 'B1': 1.3, 'B2': 1.4, 'C1': 1.5, 'C2': 1.6 };
    return Math.round(baseXP * scoreMultiplier * (levelMultipliers[userLevel] || 1));
  }

  private async _sendContextualErrorMessage(userId: string, platform: string, error: any) {
    let errorMessage = "Lo siento, estamos teniendo problemas técnicos. Por favor, inténtalo de nuevo en unos minutos. 🔧";
    await this._sendSimpleMessage(userId, platform, errorMessage);
  }

  private async _sendPracticeErrorMessage(userId: string, platform: string) {
    const message = `Tuvimos un problema técnico, pero no te preocupes: tu práctica y progreso se guardaron. ¡Puedes seguir practicando! 🚀`;
    await this._sendSimpleMessage(userId, platform, message);
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
    if (!prompt) {
      logger.error('Could not find any prompt for', { level, type, persona, id });
    }
    return prompt;
  }

  private async _updateUserProgressInTransaction(tx: any, userId: string, xpEarned: number) {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found in transaction');

    const now = new Date();
    const lastActivity = new Date(user.lastActivity);
    const daysDiff = Math.floor((now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));
    const newStreak = (daysDiff === 1) ? user.streak + 1 : (daysDiff > 1 ? 1 : user.streak);

    await tx.user.update({
      where: { id: userId },
      data: { xp: { increment: xpEarned }, streak: newStreak, lastActivity: now }
    });
    logUserAction(userId, 'progress_updated', { xpEarned, newStreak });
  }

  private async _sendFeedbackToUser(userId: string, platform: string, audioUrl: string | undefined, textSummary: string) {
    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId, platform, audioUrl, text: textSummary
      }, { headers: { 'x-api-key': this.internalApiKey }});
      logUserAction(userId, 'feedback_sent', { platform, hasAudio: !!audioUrl });
    } catch (error) {
      logger.error('Error sending feedback to user:', { userId, platform, error });
    }
  }

  private async _checkLevelUpEligibility(userId: string) {
    // TODO: Implement logic from ProgressionService
    logger.info('Placeholder: Checking level up eligibility', { userId });
  }

  private _countWords(text: string): number {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(Boolean).length;
  }
}

export const orchestratorService = new OrchestratorService();
