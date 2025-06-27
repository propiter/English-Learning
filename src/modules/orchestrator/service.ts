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
 * Main orchestrator service that coordinates all user interactions
 */
export class OrchestratorService {
  private readonly baseURL = env.API_BASE_URL;
  private readonly internalApiKey = env.INTERNAL_API_KEY;

  /**
   * Handle incoming user message and orchestrate the complete flow
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

      // 1. Get user profile
      const user = await this._fetchUserProfile(userId, platform);
      if (!user) {
        throw createError(`User not found: ${userId}`, 404);
      }

      // 2. Handle onboarding flow if needed
      if (user.isOnboarding) {
        return await this._handleOnboardingFlow(user, audioInput, platform);
      }

      // 3. Process the practice session
      return await this._processPracticeSession(user, audioInput, platform, messageData);

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Error in orchestrator service:', {
        userId,
        platform,
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Send error message to user
      await this._sendErrorMessage(userId, platform);
      throw error;
    }
  }

  /**
   * Fetch user profile with error handling
   */
  private async _fetchUserProfile(userId: string, platform: 'telegram' | 'whatsapp') {
    try {
      const user = await userService.getUserByPlatformId(platform, userId);
      if (user) {
        logUserAction(userId, 'user_profile_fetched', { platform, level: user.cefrLevel });
      }
      return user;
    } catch (error) {
      logger.error('Error fetching user profile:', { userId, platform, error });
      return null;
    }
  }

  /**
   * Handle onboarding flow
   */
  private async _handleOnboardingFlow(user: any, audioInput: string, platform: string) {
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
      throw createError('Onboarding process failed', 500);
    }
  }

  /**
   * Process practice session
   */
  private async _processPracticeSession(user: any, audioInput: string, platform: string, messageData: any) {
    // Use database transaction to ensure data consistency
    return await prisma.$transaction(async (tx) => {
      // 1. Transcribe audio
      const transcription = await this._transcribeAudio(audioInput, user.id);
      
      // 2. Evaluate speech
      const evaluation = await this._evaluateSpeech(transcription, user.cefrLevel);
      
      // 3. Get prompts
      const [teacherPrompt, summaryPrompt] = await Promise.all([
        this._getPrompt(user.cefrLevel, 'teacher_feedback', 'alex'),
        this._getPrompt(user.cefrLevel, 'text_summary', 'reporter')
      ]);

      // 4. Generate feedback
      const [audioFeedback, textSummary] = await Promise.all([
        this._generateAudioFeedback(teacherPrompt.systemMessage, transcription, evaluation, user),
        this._generateTextSummary(summaryPrompt.systemMessage, transcription, evaluation, user)
      ]);

      // 5. Calculate XP
      const xpEarned = await this._calculateXP(evaluation.overall, 0, 'daily_practice', user.cefrLevel);

      // 6. Save session (within transaction)
      const session = await tx.session.create({
        data: {
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
        }
      });

      // 7. Update user progress (within transaction)
      const updatedUser = await this._updateUserProgressInTransaction(tx, user.id, xpEarned);

      // 8. Send feedback to user (outside transaction)
      await this._sendFeedbackToUser(user.id, platform, audioFeedback, textSummary);

      // 9. Check for level up eligibility
      const levelUpCheck = await this._checkLevelUpEligibility(user.id);

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
        levelUp: levelUpCheck.eligible,
        newLevel: levelUpCheck.eligible ? levelUpCheck.nextLevel : undefined
      };
    });
  }

  /**
   * Transcribe audio using OpenAI Whisper
   */
  private async _transcribeAudio(audioFilePath: string, userId: string): Promise<string> {
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

      // In production, this would handle actual audio file processing
      // For now, we'll use a placeholder
      logger.warn('Audio transcription not fully implemented', { userId, audioFilePath });
      
      logApiCall('openai-whisper', 'transcribe', Date.now() - startTime, false, 'Not implemented');
      return "I'm practicing my English today and working on improving my pronunciation.";

    } catch (error) {
      logApiCall('openai-whisper', 'transcribe', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
      logger.error('Error transcribing audio:', { userId, error });
      
      // Return fallback transcription instead of throwing
      return "I'm practicing my English conversation skills.";
    }
  }

  /**
   * Evaluate speech with retry logic
   */
  private async _evaluateSpeech(transcription: string, userLevel: string): Promise<EvaluationResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      
      try {
        // For development, return mock evaluation
        if (process.env.NODE_ENV === 'development') {
          const mockEvaluation = this._getMockEvaluation();
          logApiCall('evaluation-api', 'evaluate', Date.now() - startTime, true);
          return mockEvaluation;
        }

        // Real API call
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
        lastError = error as Error;
        logApiCall('evaluation-api', 'evaluate', Date.now() - startTime, false, lastError.message);
        
        if (attempt === maxRetries) {
          logger.error(`Evaluation API failed after ${maxRetries} attempts:`, { 
            transcription: transcription.substring(0, 100),
            userLevel,
            error: lastError.message 
          });
          return this._getDefaultEvaluation();
        }
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }

    return this._getDefaultEvaluation();
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
        timeout: 10000
      });
      return response.data.data.prompt;
    } catch (error) {
      logger.error('Error fetching prompt:', { level, type, persona, error });
      // Return default prompt
      return {
        systemMessage: "You are Alex, a friendly AI English teacher. Provide encouraging feedback to help students improve their English skills."
      };
    }
  }

  /**
   * Generate audio feedback using OpenAI TTS
   */
  private async _generateAudioFeedback(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
    try {
      // 1. Generate feedback text
      const feedbackText = await this._generateFeedbackText(systemPrompt, transcription, evaluation, user);

      // 2. For development, return mock URL
      if (process.env.NODE_ENV === 'development') {
        return `https://storage.example.com/feedback/${Date.now()}.mp3`;
      }

      // 3. Convert text to speech using OpenAI TTS
      const startTime = Date.now();
      const mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: feedbackText,
        speed: 0.9
      });

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
   * Generate feedback text using OpenAI
   */
  private async _generateFeedbackText(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
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

      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 200,
        temperature: 0.7
      });

      logApiCall('openai-gpt', 'chat-completion', Date.now() - startTime, true);
      return completion.choices[0].message.content || "Great job practicing! Keep up the good work!";

    } catch (error) {
      logApiCall('openai-gpt', 'chat-completion', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
      logger.error('Error generating feedback text:', { userId: user.id, error });
      return "Great job practicing! Keep up the good work!";
    }
  }

  /**
   * Generate text summary in Spanish
   */
  private async _generateTextSummary(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
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

      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 150,
        temperature: 0.6
      });

      logApiCall('openai-gpt', 'chat-completion-summary', Date.now() - startTime, true);
      return completion.choices[0].message.content || "¡Buen trabajo practicando!";

    } catch (error) {
      logApiCall('openai-gpt', 'chat-completion-summary', Date.now() - startTime, false, error instanceof Error ? error.message : 'Unknown error');
      logger.error('Error generating text summary:', { userId: user.id, error });
      return "¡Buen trabajo practicando! Sigue así.";
    }
  }

  /**
   * Calculate XP for session
   */
  private async _calculateXP(score: number, duration: number, sessionType: string, userLevel: string): Promise<number> {
    try {
      const response = await axios.post(`${this.baseURL}/api/learning/sessions/calculate-xp`, {
        overallScore: score,
        duration,
        sessionType,
        userLevel
      }, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 10000
      });
      return response.data.data.xp;
    } catch (error) {
      logger.error('Error calculating XP:', { score, sessionType, userLevel, error });
      return 10; // Default XP
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
      // Don't throw - feedback sending failure shouldn't break the flow
    }
  }

  /**
   * Send error message to user
   */
  private async _sendErrorMessage(userId: string, platform: string) {
    try {
      const errorMessage = "Lo siento, estamos teniendo problemas técnicos en este momento. Por favor, inténtalo de nuevo en unos minutos. 🔧";
      
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId,
        platform,
        text: errorMessage
      }, {
        headers: { 'x-api-key': this.internalApiKey },
        timeout: 10000
      });

      logUserAction(userId, 'error_message_sent', { platform });
    } catch (error) {
      logger.error('Error sending error message:', { userId, platform, error });
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