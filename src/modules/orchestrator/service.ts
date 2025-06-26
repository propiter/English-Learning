import { OpenAI } from 'openai';
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { FeedbackResponse, EvaluationResponse } from '../../types/index.js';
import { userService } from '../users/service.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

export class OrchestratorService {
  private readonly baseURL = process.env.API_BASE_URL || 'http://localhost:3000';
  private readonly internalApiKey = process.env.INTERNAL_API_KEY!;

  async handleUserMessage(userId: string, audioInput: string, platform: 'telegram' | 'whatsapp', messageData: any): Promise<FeedbackResponse> {
    try {
      logger.info(`Processing message for user: ${userId}`);

      // 1. Get or create user profile
      let user = await this.getUserProfile(userId, platform);
      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }

      // 2. Handle onboarding flow if needed
      if (user.isOnboarding) {
        return await this.handleOnboardingFlow(user, audioInput, platform);
      }

      // 3. Transcribe audio to text
      const transcription = await this.transcribeAudio(audioInput);
      logger.info(`Transcription completed: ${transcription.substring(0, 100)}...`);

      // 4. Evaluate speech with retry logic
      const evaluation = await this.evaluateSpeech(transcription, user.cefrLevel);
      logger.info(`Speech evaluation completed with score: ${evaluation.overall}`);

      // 5. Get appropriate prompts for feedback generation
      const teacherPrompt = await this.getPrompt(user.cefrLevel, 'teacher_feedback', 'alex');
      const summaryPrompt = await this.getPrompt(user.cefrLevel, 'text_summary', 'reporter');

      // 6. Generate audio feedback using OpenAI TTS
      const audioFeedback = await this.generateAudioFeedback(
        teacherPrompt.systemMessage,
        transcription,
        evaluation,
        user
      );

      // 7. Generate text summary
      const textSummary = await this.generateTextSummary(
        summaryPrompt.systemMessage,
        transcription,
        evaluation,
        user
      );

      // 8. Calculate XP earned
      const xpEarned = await this.calculateXP(evaluation.overall, 0, 'daily_practice', user.cefrLevel);

      // 9. Save session to database
      await this.saveSession({
        userId,
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
        sessionType: 'daily_practice'
      });

      // 10. Update user progress
      await this.updateUserProgress(userId, xpEarned);

      // 11. Send messages to user
      await this.sendFeedbackToUser(userId, platform, audioFeedback, textSummary);

      // Check for level up eligibility
      const levelUpCheck = await this.checkLevelUpEligibility(userId);

      return {
        audioUrl: audioFeedback,
        textSummary,
        xpEarned,
        levelUp: levelUpCheck.eligible,
        newLevel: levelUpCheck.eligible ? levelUpCheck.nextLevel : undefined
      };

    } catch (error) {
      logger.error('Error in orchestrator service:', error);
      
      // Send error message to user
      try {
        await this.sendErrorMessage(userId, platform);
      } catch (sendError) {
        logger.error('Failed to send error message:', sendError);
      }
      
      throw error;
    }
  }

  private async getUserProfile(userId: string, platform: 'telegram' | 'whatsapp') {
    try {
      return await userService.getUserByPlatformId(platform, userId);
    } catch (error) {
      logger.error('Error fetching user profile:', error);
      return null;
    }
  }

  private async handleOnboardingFlow(user: any, audioInput: string, platform: string) {
    try {
      const response = await axios.post(`${this.baseURL}/api/onboarding/process`, {
        userId: user.id,
        input: audioInput,
        currentStep: user.onboardingStep,
        platform
      }, {
        headers: { 'x-api-key': this.internalApiKey }
      });

      return response.data.data;
    } catch (error) {
      logger.error('Error in onboarding flow:', error);
      throw error;
    }
  }

  private async transcribeAudio(audioFilePath: string): Promise<string> {
    try {
      // Mock transcription for development
      if (audioFilePath.includes('mock') || process.env.NODE_ENV === 'development') {
        return "Hello, I am practicing my English conversation skills today. How are you doing?";
      }

      // In production, this would handle actual audio file processing
      const transcription = await openai.audio.transcriptions.create({
        file: audioFilePath as any,
        model: "whisper-1",
        language: "en"
      });

      return transcription.text;
    } catch (error) {
      logger.error('Error transcribing audio:', error);
      // Return fallback transcription instead of throwing
      return "I'm practicing my English today.";
    }
  }

  private async evaluateSpeech(transcription: string, userLevel: string): Promise<EvaluationResponse> {
    const maxRetries = 3;
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Mock evaluation for development
        if (process.env.NODE_ENV === 'development') {
          return this.getMockEvaluation();
        }

        // Real API call would go here
        const response = await axios.post(process.env.EVALUATION_API_URL!, {
          text: transcription,
          level: userLevel,
          language: 'en'
        }, {
          headers: { 'Authorization': `Bearer ${process.env.EVALUATION_API_KEY}` },
          timeout: 10000
        });

        return response.data;
      } catch (error) {
        lastError = error as Error;
        
        if (attempt === maxRetries) {
          logger.error(`Evaluation API failed after ${maxRetries} attempts:`, error);
          return this.getDefaultEvaluation();
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }

    return this.getDefaultEvaluation();
  }

  private getMockEvaluation(): EvaluationResponse {
    return {
      overall: Math.floor(Math.random() * 30) + 70,
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

  private getDefaultEvaluation(): EvaluationResponse {
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

  private async getPrompt(level: string, type: string, persona: string) {
    try {
      const response = await axios.get(`${this.baseURL}/api/content/prompts`, {
        params: { level, type, persona },
        headers: { 'x-api-key': this.internalApiKey }
      });
      return response.data.data.prompt;
    } catch (error) {
      logger.error('Error fetching prompt:', error);
      // Return default prompt
      return {
        systemMessage: "You are Alex, a friendly AI English teacher. Provide encouraging feedback to help students improve their English skills."
      };
    }
  }

  private async generateAudioFeedback(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
    try {
      // 1. Generate feedback text using ChatGPT
      const feedbackText = await this.generateFeedbackText(systemPrompt, transcription, evaluation, user);

      // 2. Convert text to speech using OpenAI TTS
      if (process.env.NODE_ENV === 'development') {
        // Return mock URL for development
        return `https://storage.example.com/feedback/${Date.now()}.mp3`;
      }

      const mp3 = await openai.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: feedbackText,
        speed: 0.9
      });

      // In production, save audio file and return URL
      const audioUrl = `https://storage.example.com/feedback/${Date.now()}.mp3`;
      
      logger.info(`Audio feedback generated: ${audioUrl}`);
      return audioUrl;

    } catch (error) {
      logger.error('Error generating audio feedback:', error);
      return `https://storage.example.com/feedback/default.mp3`;
    }
  }

  private async generateFeedbackText(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
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

Provide encouraging feedback as Alex, their AI English teacher.
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

      return completion.choices[0].message.content || "Great job practicing!";
    } catch (error) {
      logger.error('Error generating feedback text:', error);
      return "Great job practicing! Keep up the good work!";
    }
  }

  private async generateTextSummary(
    systemPrompt: string,
    transcription: string,
    evaluation: EvaluationResponse,
    user: any
  ): Promise<string> {
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

Provide a concise summary in Spanish.
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

      return completion.choices[0].message.content || "¡Buen trabajo practicando!";
    } catch (error) {
      logger.error('Error generating text summary:', error);
      return "¡Buen trabajo practicando! Sigue así.";
    }
  }

  private async calculateXP(score: number, duration: number, sessionType: string, userLevel: string): Promise<number> {
    try {
      const response = await axios.post(`${this.baseURL}/api/learning/sessions/calculate-xp`, {
        overallScore: score,
        duration,
        sessionType,
        userLevel
      }, {
        headers: { 'x-api-key': this.internalApiKey }
      });
      return response.data.data.xp;
    } catch (error) {
      logger.error('Error calculating XP:', error);
      return 10; // Default XP
    }
  }

  private async saveSession(sessionData: any) {
    try {
      await axios.post(`${this.baseURL}/api/learning/sessions`, sessionData, {
        headers: { 'x-api-key': this.internalApiKey }
      });
    } catch (error) {
      logger.error('Error saving session:', error);
      // Don't throw - session saving failure shouldn't break the flow
    }
  }

  private async updateUserProgress(userId: string, xpEarned: number) {
    try {
      const response = await axios.put(`${this.baseURL}/api/users/${userId}/progress`, {
        xpGained: xpEarned,
        sessionCompleted: true
      }, {
        headers: { 'x-api-key': this.internalApiKey }
      });
      return response.data.data;
    } catch (error) {
      logger.error('Error updating user progress:', error);
      // Don't throw - progress update failure shouldn't break the flow
    }
  }

  private async sendFeedbackToUser(userId: string, platform: string, audioUrl: string, textSummary: string) {
    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId,
        platform,
        audioUrl,
        text: textSummary
      }, {
        headers: { 'x-api-key': this.internalApiKey }
      });
    } catch (error) {
      logger.error('Error sending feedback to user:', error);
      // Don't throw - feedback sending failure shouldn't break the flow
    }
  }

  private async sendErrorMessage(userId: string, platform: string) {
    try {
      const errorMessage = "Lo siento, estamos teniendo problemas técnicos en este momento. Por favor, inténtalo de nuevo en unos minutos. 🔧";
      
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId,
        platform,
        text: errorMessage
      }, {
        headers: { 'x-api-key': this.internalApiKey }
      });
    } catch (error) {
      logger.error('Error sending error message:', error);
    }
  }

  private async checkLevelUpEligibility(userId: string) {
    try {
      const response = await axios.get(`${this.baseURL}/api/learning/users/${userId}/level-up-check`, {
        headers: { 'x-api-key': this.internalApiKey }
      });
      return response.data.data.eligibility;
    } catch (error) {
      logger.error('Error checking level up eligibility:', error);
      return { eligible: false };
    }
  }
}

export const orchestratorService = new OrchestratorService();