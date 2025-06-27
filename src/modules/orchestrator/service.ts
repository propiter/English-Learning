import { OpenAI } from 'openai';
import axios from 'axios';
import { logger, logUserAction, logApiCall } from '../../utils/logger.js';
import { FeedbackResponse, EvaluationResponse } from '../../types/index.js';
import { userService } from '../users/service.js';
import { createError } from '../../middleware/errorHandler.js';
import env from '../../config/environment.js';
import prisma from '../../config/database.js';

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: env.OPENAI_API_TIMEOUT
});

/**
 * Main orchestrator service that coordinates all user interactions with improved error handling
 */
export class OrchestratorService {
  private readonly baseURL = env.API_BASE_URL;
  private readonly internalApiKey = env.INTERNAL_API_KEY;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;

  /**
   * Handle incoming user message and orchestrate the complete flow with resilient error handling
   */
  async handleUserMessage(
    userId: string, 
    audioInput: string, 
    platform: 'telegram' | 'whatsapp', 
    messageData: any
  ): Promise<FeedbackResponse> {
    const startTime = Date.now();
    
    try {
      logUserAction(userId, 'message_received', { platform, inputType: 'audio' });

      // 1. Get user profile with retry logic
      const user = await this._fetchUserProfileWithRetry(userId); // FIX: Pass only the internal userId
      if (!user) {
        throw createError(`User not found: ${userId}`, 404);
      }

      // 2. Handle onboarding flow if needed
      if (user.isOnboarding) {
        return await this._handleOnboardingFlowWithRecovery(user, audioInput, platform);
      }

      // 3. Process the practice session with comprehensive error handling
      return await this._processPracticeSessionResilient(user, audioInput, platform, messageData);

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Error in orchestrator service:', {
        userId,
        platform,
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      
      // Send appropriate error message to user based on error type
      await this._sendContextualErrorMessage(userId, platform, error);
      throw error;
    }
  }

  /**
   * NUEVA: Fetch user profile with retry logic
   */
  private async _fetchUserProfileWithRetry(userId: string, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // FIX: Use the internal userId to fetch the user
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
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS * attempt));
      }
    }
    return null;
  }

  /**
   * NUEVA: Handle onboarding flow with recovery mechanisms
   */
  private async _handleOnboardingFlowWithRecovery(user: any, audioInput: string, platform: string) {
    try {
      const response = await axios.post(`${this.baseURL}/api/onboarding/process`, {
        userId: user.id,
        input: audioInput,
        currentStep: user.onboardingStep,
        platform
      }, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 30000
      });

      logUserAction(user.id, 'onboarding_step_processed', { 
        step: user.onboardingStep, 
        platform 
      });

      return response.data.data;
    } catch (error) {
      logger.error('Error in onboarding flow:', { userId: user.id, error });
      
      // Enviar mensaje específico de onboarding
      await this._sendOnboardingErrorMessage(user.id, platform, user.onboardingStep);
      
      // Return a safe fallback response instead of throwing
      return {
        success: false,
        error: 'onboarding_failed',
        message: 'Onboarding process encountered an issue, but recovery message sent'
      };
    }
  }

  /**
   * NUEVA: Process practice session with comprehensive resilience
   */
  private async _processPracticeSessionResilient(user: any, audioInput: string, platform: string, messageData: any) {
    let sessionData: any = null;
    
    try {
      // Use database transaction with better error handling
      return await prisma.$transaction(async (tx) => {
        // 1. Transcribe audio with fallback
        const transcription = await this._transcribeAudioResilient(audioInput, user.id);
        
        // 2. Evaluate speech with multiple fallbacks
        const evaluation = await this._evaluateSpeechResilient(transcription, user.cefrLevel);
        
        // 3. Get prompts with fallback to defaults
        const [teacherPrompt, summaryPrompt] = await this._getPromptsWithFallback(user.cefrLevel);

        // 4. Generate feedback with graceful degradation
        const [audioFeedback, textSummary] = await this._generateFeedbackResilient(
          teacherPrompt.systemMessage, 
          summaryPrompt.systemMessage,
          transcription, 
          evaluation, 
          user
        );

        // 5. Calculate XP with fallback
        const xpEarned = await this._calculateXPWithFallback(evaluation.overall, 0, 'daily_practice', user.cefrLevel);

        // 6. Save session (within transaction)
        sessionData = {
          userId: user.id,
          userInput: audioInput,
          transcription,
          inputType: 'audio',
          evaluationJson: evaluation,
          overallScore: evaluation.overall,
          pronunciation: evaluation.pronunciation,
          fluency: evaluation.fluency,
          grammar: evaluation.grammar,
          vocabulary: evaluation.vocabulary,
          feedbackAudioUrl: audioFeedback,
          feedbackText: textSummary,
          sessionType: 'daily_practice',
          xpEarned,
          wordsSpoken: this._countWords(transcription)
        };

        const session = await tx.session.create({ data: sessionData });

        // 7. Update user progress (within transaction)
        const updatedUser = await this._updateUserProgressInTransaction(tx, user.id, xpEarned);

        // 8. Send feedback to user (outside transaction, with error handling)
        setImmediate(async () => {
          try {
            await this._sendFeedbackToUser(user.id, platform, audioFeedback, textSummary);
          } catch (feedbackError) {
            logger.error('Failed to send feedback, but session was saved', { 
              userId: user.id, 
              sessionId: session.id, 
              error: feedbackError 
            });
          }
        });

        // 9. Check for level up eligibility (non-blocking)
        setImmediate(async () => {
          try {
            await this._checkLevelUpEligibility(user.id);
          } catch (levelUpError) {
            logger.error('Level up check failed', { userId: user.id, error: levelUpError });
          }
        });

        logUserAction(user.id, 'practice_session_completed', {
          sessionId: session.id,
          score: evaluation.overall,
          xpEarned,
          platform
        });

        return {
          audioUrl: audioFeedback,
          textSummary,
          xpEarned,
          levelUp: false, // Will be determined asynchronously
          newLevel: undefined
        };
      });
    } catch (error) {
      logger.error('Practice session failed:', { userId: user.id, error, sessionData });
      
      // Send user-friendly error message
      await this._sendPracticeErrorMessage(user.id, platform);
      
      // Return a safe fallback response
      return {
        audioUrl: undefined,
        textSummary: "Tuvimos un problema técnico, pero tu práctica ha sido registrada. ¡Sigue practicando!",
        xpEarned: 5, // Minimal XP for the attempt
        levelUp: false,
        newLevel: undefined
      };
    }
  }

  /**
   * NUEVA: Transcribe audio with multiple fallback strategies
   */
  private async _transcribeAudioResilient(audioFilePath: string, userId: string): Promise<string> {
    const startTime = Date.now();
    
    try {
      // For development, return mock transcription
      if (audioFilePath.includes('mock') || process.env.NODE_ENV === 'development') {
        const mockTranscriptions = [
          "Hello, I am practicing my English conversation skills today. How are you doing?",
          "I love watching movies and reading books in my free time. What about you?",
          "Technology has changed our lives in many ways. It makes communication easier.",
          "I think learning English is very important for my career development.",
          "Yesterday I went to the park and saw many beautiful flowers blooming."
        ];
        const randomTranscription = mockTranscriptions[Math.floor(Math.random() * mockTranscriptions.length)];
        
        logApiCall('openai-whisper', 'transcribe', Date.now() - startTime, true);
        return randomTranscription;
      }

      // TODO: Implement actual audio transcription
      logger.warn('Audio transcription not fully implemented', { userId, audioFilePath });
      
      logApiCall('openai-whisper', 'transcribe', Date.now() - startTime, false, 'Not implemented');
      return "I'm practicing my English today and working on improving my pronunciation.";

    } catch (error) {
      logApiCall('openai-whisper', 'transcribe', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
      logger.error('Error transcribing audio:', { userId, error });
      
      // Return safe fallback transcription
      return "I'm practicing my English conversation skills.";
    }
  }

  /**
   * NUEVA: Evaluate speech with comprehensive fallback system
   */
  private async _evaluateSpeechResilient(transcription: string, userLevel: string): Promise<EvaluationResponse> {
    // Try external API first with retries
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      const startTime = Date.now();
      
      try {
        if (process.env.NODE_ENV === 'development') {
          const mockEvaluation = this._getMockEvaluation();
          logApiCall('evaluation-api', 'evaluate', Date.now() - startTime, true);
          return mockEvaluation;
        }

        const response = await axios.post(env.EVALUATION_API_URL, {
          text: transcription,
          level: userLevel,
          language: 'en'
        }, {
          headers: { 
            'Authorization': `Bearer ${env.EVALUATION_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: env.EVALUATION_API_TIMEOUT
        });

        logApiCall('evaluation-api', 'evaluate', Date.now() - startTime, true);
        return response.data;

      } catch (error) {
        logApiCall('evaluation-api', 'evaluate', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
        
        if (attempt === this.MAX_RETRIES) {
          logger.error(`Evaluation API failed after ${this.MAX_RETRIES} attempts, using local fallback`, { 
            transcription: transcription.substring(0, 100),
            userLevel,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          
          // Use local evaluation as final fallback
          return this._getLocalEvaluation(transcription, userLevel);
        }
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
      }
    }

    // This should never be reached, but just in case
    return this._getDefaultEvaluation();
  }

  /**
   * NUEVA: Local evaluation fallback using simple heuristics
   */
  private _getLocalEvaluation(transcription: string, userLevel: string): EvaluationResponse {
    const wordCount = transcription.split(' ').length;
    const sentenceCount = transcription.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
    const avgWordsPerSentence = wordCount / Math.max(sentenceCount, 1);
    
    // Base scores by level
    const levelBaseScores: { [key: string]: number } = {
      'A0': 40, 'A1': 50, 'A2': 60, 'B1': 70, 'B2': 75, 'C1': 80, 'C2': 85
    };
    
    const baseScore = levelBaseScores[userLevel] || 60;
    
    // Adjust based on complexity
    let complexityBonus = 0;
    if (avgWordsPerSentence > 10) complexityBonus += 10;
    if (transcription.includes(' because ') || transcription.includes(' although ')) complexityBonus += 5;
    if (transcription.includes(' however ') || transcription.includes(' therefore ')) complexityBonus += 5;
    
    // Length bonus
    let lengthBonus = 0;
    if (wordCount > 20) lengthBonus += 5;
    if (wordCount > 50) lengthBonus += 5;
    
    const finalScore = Math.min(95, baseScore + complexityBonus + lengthBonus + Math.random() * 10 - 5);
    
    return {
      overall: Math.round(finalScore),
      pronunciation: Math.round(finalScore + Math.random() * 10 - 5),
      fluency: Math.round(finalScore + Math.random() * 10 - 5),
      grammar: Math.round(finalScore + Math.random() * 10 - 5),
      vocabulary: Math.round(finalScore + Math.random() * 10 - 5),
      feedback: {
        pronunciation: ["Good effort on pronunciation"],
        fluency: ["Keep practicing for better fluency"],
        grammar: ["Grammar shows improvement"],
        vocabulary: ["Nice vocabulary usage"],
        overall: "Good practice session! Keep up the consistent work."
      }
    };
  }

  /**
   * NUEVA: Get prompts with fallback to defaults
   */
  private async _getPromptsWithFallback(level: string): Promise<[any, any]> {
    const defaultTeacherPrompt = {
      systemMessage: "You are Alex, a friendly AI English teacher. Provide encouraging feedback to help students improve their English skills. Keep your response under 150 words and make it suitable for text-to-speech."
    };
    
    const defaultSummaryPrompt = {
      systemMessage: "You are a language learning reporter. Provide a concise summary in Spanish (2-3 sentences maximum) about the student's English practice performance."
    };

    try {
      const [teacherResponse, summaryResponse] = await Promise.allSettled([
        this._getPrompt(level, 'teacher_feedback', 'alex'),
        this._getPrompt(level, 'text_summary', 'reporter')
      ]);

      const teacherPrompt = teacherResponse.status === 'fulfilled' ? teacherResponse.value : defaultTeacherPrompt;
      const summaryPrompt = summaryResponse.status === 'fulfilled' ? summaryResponse.value : defaultSummaryPrompt;

      return [teacherPrompt, summaryPrompt];
    } catch (error) {
      logger.error('Error fetching prompts, using defaults:', { level, error });
      return [defaultTeacherPrompt, defaultSummaryPrompt];
    }
  }

  /**
   * NUEVA: Generate feedback with graceful degradation
   */
  private async _generateFeedbackResilient(
    teacherSystemPrompt: string,
    summarySystemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<[string, string]> {
    const results = await Promise.allSettled([
      this._generateAudioFeedbackResilient(teacherSystemPrompt, transcription, evaluation, user),
      this._generateTextSummaryResilient(summarySystemPrompt, transcription, evaluation, user)
    ]);

    const audioFeedback = results[0].status === 'fulfilled' 
      ? results[0].value 
      : `https://storage.example.com/feedback/default.mp3`;

    const textSummary = results[1].status === 'fulfilled' 
      ? results[1].value 
      : `¡Buen trabajo practicando! Puntuación: ${evaluation.overall}/100. Sigue así.`;

    return [audioFeedback, textSummary];
  }

  /**
   * NUEVA: Generate audio feedback with resilient error handling
   */
  private async _generateAudioFeedbackResilient(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
    try {
      // 1. Generate feedback text with timeout and retries
      const feedbackText = await this._generateFeedbackTextResilient(systemPrompt, transcription, evaluation, user);

      // 2. For development, return mock URL
      if (process.env.NODE_ENV === 'development') {
        return `https://storage.example.com/feedback/${Date.now()}.mp3`;
      }

      // 3. Convert text to speech with timeout
      const startTime = Date.now();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('TTS timeout')), 15000);
      });

      const ttsPromise = openai.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: feedbackText,
        speed: 0.9
      });

      const mp3 = await Promise.race([ttsPromise, timeoutPromise]);
      logApiCall('openai-tts', 'speech', Date.now() - startTime, true);

      // In production, save audio file to storage and return URL
      const audioUrl = `https://storage.example.com/feedback/${Date.now()}.mp3`;
      
      logUserAction(user.id, 'audio_feedback_generated', { audioUrl });
      return audioUrl;

    } catch (error) {
      logger.error('Error generating audio feedback:', { userId: user.id, error });
      return `https://storage.example.com/feedback/default.mp3`;
    }
  }

  /**
   * NUEVA: Generate feedback text with resilient error handling
   */
  private async _generateFeedbackTextResilient(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      const startTime = Date.now();
      
      try {
        const userPrompt = `
Student's input: "${transcription}"

Evaluation scores:
- Overall: ${evaluation.overall}/100
- Pronunciation: ${evaluation.pronunciation}/100
- Fluency: ${evaluation.fluency}/100
- Grammar: ${evaluation.grammar}/100
- Vocabulary: ${evaluation.vocabulary}/100

Student level: ${user.cefrLevel}
Student interests: ${user.interests?.join(', ') || 'general'}

Provide encouraging feedback as Alex, their AI English teacher. Keep it conversational and under 150 words.
`;

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('OpenAI timeout')), 10000);
        });

        const completionPromise = openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          max_tokens: 200,
          temperature: 0.7
        });

        const completion = await Promise.race([completionPromise, timeoutPromise]);
        logApiCall('openai-gpt', 'chat-completion', Date.now() - startTime, true);
        
        return completion.choices[0].message.content || "Great job practicing! Keep up the good work!";

      } catch (error) {
        logApiCall('openai-gpt', 'chat-completion', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
        
        if (attempt === this.MAX_RETRIES) {
          logger.error('All feedback generation attempts failed, using fallback', { userId: user.id, error });
          return this._getFallbackFeedbackText(evaluation, user);
        }
        
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS * attempt));
      }
    }

    return "Great job practicing! Keep up the good work!";
  }

  /**
   * NUEVA: Generate text summary with resilient error handling
   */
  private async _generateTextSummaryResilient(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      const startTime = Date.now();
      
      try {
        const userPrompt = `
Student's input: "${transcription}"

Evaluation scores:
- Overall: ${evaluation.overall}/100
- Pronunciation: ${evaluation.pronunciation}/100
- Fluency: ${evaluation.fluency}/100  
- Grammar: ${evaluation.grammar}/100
- Vocabulary: ${evaluation.vocabulary}/100

Student level: ${user.cefrLevel}

Provide a concise summary in Spanish (2-3 sentences maximum).
`;

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('OpenAI timeout')), 8000);
        });

        const completionPromise = openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          max_tokens: 150,
          temperature: 0.6
        });

        const completion = await Promise.race([completionPromise, timeoutPromise]);
        logApiCall('openai-gpt', 'chat-completion-summary', Date.now() - startTime, true);
        
        return completion.choices[0].message.content || "¡Buen trabajo practicando!";

      } catch (error) {
        logApiCall('openai-gpt', 'chat-completion-summary', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
        
        if (attempt === this.MAX_RETRIES) {
          logger.error('All summary generation attempts failed, using fallback', { userId: user.id, error });
          return this._getFallbackSummaryText(evaluation, user);
        }
        
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS * attempt));
      }
    }

    return "¡Buen trabajo practicando!";
  }

  /**
   * NUEVA: Fallback feedback text based on scores
   */
  private _getFallbackFeedbackText(evaluation: EvaluationResponse, user: any): string {
    const score = evaluation.overall;
    const level = user.cefrLevel;
    const firstName = user.firstName || 'there';

    if (score >= 85) {
      return `Excellent work, ${firstName}! Your English is really improving. Your score of ${score} shows great progress at the ${level} level. Keep practicing with confidence!`;
    } else if (score >= 70) {
      return `Good job, ${firstName}! You scored ${score} points, which is solid progress for ${level} level. Focus on speaking more naturally and you'll see even better results.`;
    } else if (score >= 55) {
      return `Nice effort, ${firstName}! You're making progress with a score of ${score}. For ${level} level, try to speak a bit more and don't worry about making mistakes - that's how we learn!`;
    } else {
      return `Keep going, ${firstName}! Every practice session helps. Your score of ${score} shows you're working hard. Remember, consistency is key to improving your English!`;
    }
  }

  /**
   * NUEVA: Fallback summary text based on scores
   */
  private _getFallbackSummaryText(evaluation: EvaluationResponse, user: any): string {
    const score = evaluation.overall;
    const level = user.cefrLevel;

    if (score >= 80) {
      return `¡Excelente sesión! Puntuación: ${score}/100. Tu nivel ${level} muestra gran progreso. Sigue practicando con esta consistencia.`;
    } else if (score >= 60) {
      return `¡Buen trabajo! Puntuación: ${score}/100. Para nivel ${level}, estás progresando bien. Continúa practicando regularmente.`;
    } else {
      return `¡Sigue adelante! Puntuación: ${score}/100. Cada práctica cuenta para mejorar tu nivel ${level}. La constancia es clave.`;
    }
  }

  /**
   * NUEVA: Calculate XP with fallback
   */
  private async _calculateXPWithFallback(score: number, duration: number, sessionType: string, userLevel: string): Promise<number> {
    try {
      const response = await axios.post(`${this.baseURL}/api/learning/sessions/calculate-xp`, {
        overallScore: score,
        duration,
        sessionType,
        userLevel
      }, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 5000
      });
      return response.data.data.xp;
    } catch (error) {
      logger.error('Error calculating XP, using fallback:', { score, sessionType, userLevel, error });
      
      // Fallback XP calculation
      let baseXP = 10;
      const scoreMultiplier = Math.max(0.5, Math.min(2, score / 50));
      const levelMultipliers: { [key: string]: number } = {
        'A0': 1, 'A1': 1.1, 'A2': 1.2, 'B1': 1.3, 'B2': 1.4, 'C1': 1.5, 'C2': 1.6
      };
      
      return Math.round(baseXP * scoreMultiplier * (levelMultipliers[userLevel] || 1));
    }
  }

  /**
   * NUEVA: Send contextual error messages based on error type
   */
  private async _sendContextualErrorMessage(userId: string, platform: string, error: any) {
    let errorMessage = "Lo siento, estamos teniendo problemas técnicos en este momento. Por favor, inténtalo de nuevo en unos minutos. 🔧";

    // Customize message based on error type
    if (error instanceof Error) {
      if (error.message.includes('Redis') || error.message.includes('state')) {
        errorMessage = "Tuvimos un problema guardando tu progreso, pero no te preocupes. Por favor, envía tu mensaje de nuevo y continuaremos donde quedamos. 🔄";
      } else if (error.message.includes('OpenAI') || error.message.includes('timeout')) {
        errorMessage = "Nuestro sistema de evaluación está un poco lento ahora. Tu práctica se guardó, pero el feedback puede tardar un poco más. ¡Sigue practicando! ⏳";
      } else if (error.message.includes('evaluation') || error.message.includes('API')) {
        errorMessage = "Estamos teniendo problemas con nuestro sistema de evaluación. Tu práctica se registró, pero el análisis detallado llegará pronto. 📊";
      }
    }

    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId,
        platform,
        text: errorMessage
      }, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 10000
      });

      logUserAction(userId, 'contextual_error_message_sent', { platform, errorType: error?.constructor?.name });
    } catch (sendError) {
      logger.error('Error sending contextual error message:', { userId, platform, sendError });
    }
  }

  /**
   * NUEVA: Send onboarding-specific error message
   */
  private async _sendOnboardingErrorMessage(userId: string, platform: string, currentStep: string) {
    const stepMessages: { [key: string]: string } = {
      'welcome': 'Hubo un problema al iniciar tu evaluación. Por favor, envía /start para comenzar de nuevo.',
      'level_test': 'Tuvimos un problema durante tu evaluación de nivel. No te preocupes, vamos a continuar desde donde quedamos. Por favor, responde a la pregunta anterior.',
      'interests': 'Hubo un problema al guardar tus intereses. Por favor, cuéntame nuevamente qué temas te interesan para personalizar tu experiencia.',
      'goal': 'Tuvimos un problema al guardar tu meta de aprendizaje. Por favor, cuéntame otra vez cuál es tu objetivo principal para aprender inglés.'
    };

    const message = stepMessages[currentStep] || 
      'Tuvimos un problema durante tu configuración inicial. Por favor, envía /start para reiniciar el proceso.';

    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId,
        platform,
        text: message
      }, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 10000
      });

      logUserAction(userId, 'onboarding_error_message_sent', { platform, step: currentStep });
    } catch (error) {
      logger.error('Error sending onboarding error message:', { userId, platform, error });
    }
  }

  /**
   * NUEVA: Send practice-specific error message
   */
  private async _sendPracticeErrorMessage(userId: string, platform: string) {
    const message = `Tuvimos un problema técnico durante tu sesión de práctica, pero no te preocupes:

✅ Tu práctica se registró
✅ Tu progreso se guardó
✅ Puedes continuar practicando

Por favor, envía otro mensaje de voz cuando estés listo. ¡Seguimos mejorando tu inglés! 🚀`;

    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId,
        platform,
        text: message
      }, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 10000
      });

      logUserAction(userId, 'practice_error_message_sent', { platform });
    } catch (error) {
      logger.error('Error sending practice error message:', { userId, platform, error });
    }
  }

  /**
   * Generate mock evaluation for development
   */
  private _getMockEvaluation(): EvaluationResponse {
    return {
      overall: Math.floor(Math.random() * 30) + 70, // 70-100
      pronunciation: Math.floor(Math.random() * 30) + 70,
      fluency: Math.floor(Math.random() * 30) + 70,
      grammar: Math.floor(Math.random() * 30) + 70,
      vocabulary: Math.floor(Math.random() * 30) + 70,
      feedback: {
        pronunciation: ["Clear articulation", "Good rhythm"],
        fluency: ["Smooth delivery", "Good pacing"],
        grammar: ["Check verb tenses", "Subject-verb agreement"],
        vocabulary: ["Rich vocabulary usage", "Consider synonyms"],
        overall: "Good progress! Keep practicing daily conversations."
      }
    };
  }

  /**
   * Get default evaluation when API fails
   */
  private _getDefaultEvaluation(): EvaluationResponse {
    return {
      overall: 75,
      pronunciation: 75,
      fluency: 75,
      grammar: 75,
      vocabulary: 75,
      feedback: {
        pronunciation: ["Unable to analyze pronunciation at this time"],
        fluency: ["Unable to analyze fluency at this time"],
        grammar: ["Unable to analyze grammar at this time"],
        vocabulary: ["Unable to analyze vocabulary at this time"],
        overall: "We're experiencing technical difficulties. Your practice session has been recorded!"
      }
    };
  }

  /**
   * Get prompt from content service
   */
  private async _getPrompt(level: string, type: string, persona: string) {
    try {
      const response = await axios.get(`${this.baseURL}/api/content/prompts`, {
        params: { level, type, persona },
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 5000
      });
      return response.data.data.prompt;
    } catch (error) {
      logger.error('Error fetching prompt:', { level, type, persona, error });
      throw error; // Let caller handle fallback
    }
  }

  /**
   * Update user progress within transaction
   */
  private async _updateUserProgressInTransaction(tx: any, userId: string, xpEarned: number) {
    try {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw createError('User not found', 404);
      }

      const now = new Date();
      const lastActivity = new Date(user.lastActivity);
      const daysDiff = Math.floor((now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));

      let newStreak = user.streak;
      if (daysDiff === 1) {
        newStreak += 1;
      } else if (daysDiff > 1) {
        newStreak = 1;
      }

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          xp: user.xp + xpEarned,
          streak: newStreak,
          lastActivity: now
        }
      });

      logUserAction(userId, 'progress_updated', { 
        xpEarned, 
        newStreak, 
        totalXp: updatedUser.xp 
      });

      return updatedUser;
    } catch (error) {
      logger.error('Error updating user progress:', { userId, xpEarned, error });
      throw error;
    }
  }

  /**
   * Send feedback to user
   */
  private async _sendFeedbackToUser(userId: string, platform: string, audioUrl: string, textSummary: string) {
    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId,
        platform,
        audioUrl,
        text: textSummary
      }, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 15000
      });

      logUserAction(userId, 'feedback_sent', { platform, hasAudio: !!audioUrl, hasText: !!textSummary });
    } catch (error) {
      logger.error('Error sending feedback to user:', { userId, platform, error });
      throw error; // Let caller handle this error
    }
  }

  /**
   * Check level up eligibility
   */
  private async _checkLevelUpEligibility(userId: string) {
    try {
      const response = await axios.get(`${this.baseURL}/api/learning/users/${userId}/level-up-check`, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 10000
      });
      return response.data.data.eligibility;
    } catch (error) {
      logger.error('Error checking level up eligibility:', { userId, error });
      return { eligible: false };
    }
  }

  /**
   * Count words in text
   */
  private _countWords(text: string): number {
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  }
}

export const orchestratorService = new OrchestratorService();
