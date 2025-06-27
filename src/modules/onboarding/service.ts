import prisma from '../../config/database.js';
import redisManager from '../../config/redis.js';
import { logger, logUserAction } from '../../utils/logger.js';
import { CEFR_LEVELS } from '../../types/index.js';
import { createError } from '../../middleware/errorHandler.js';
import { messagingGatewayService } from '../gateway/service.js';
import { Platform } from '../../types/index.js';
import { OpenAI } from 'openai';
import env from '../../config/environment.js';

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: env.OPENAI_API_TIMEOUT
});

/**
 * Onboarding state interface
 */
interface OnboardingState {
  step: string;
  testQuestions?: any[];
  currentQuestionIndex?: number;
  responses?: any[];
  determinedLevel?: string;
  interests?: string[];
  goal?: string;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Onboarding service for managing the new conversational, agent-driven onboarding flow.
 */
export class OnboardingService {
  private readonly ONBOARDING_TTL = 3600; // 1 hour

  /**
   * Process an onboarding step. This is the main entry point from the orchestrator.
   */
  async processOnboardingStep(userId: string, input: string, currentStep: string, platform: Platform) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw createError('User not found', 404);

      logger.info('Processing onboarding step', { userId, currentStep, platform });
      logUserAction(userId, 'onboarding_step_started', { step: currentStep, platform });

      let state = await this.getOnboardingState(userId);

      // If state is lost mid-flow, restart gracefully.
      if (!state && currentStep !== 'welcome') {
        logger.warn('Onboarding state not found mid-flow, restarting.', { userId });
        await this.sendMessage(user.id, platform, `¡Hola ${user.firstName}! Parece que nos perdimos. No te preocupes, empecemos de nuevo para asegurarnos de que todo quede perfecto.`);
        return await this.handleWelcomeStep(user, platform);
      }

      switch (currentStep) {
        case 'welcome':
          return await this.handleWelcomeStep(user, platform);
        case 'level_test':
          return await this.handleLevelTestStep(user, input, platform, state!);
        case 'interests':
          return await this.handleInterestsStep(user, input, platform, state!);
        case 'goal':
          return await this.handleGoalStep(user, input, platform, state!);
        default:
          logger.warn('Invalid or completed onboarding step, finishing up.', { userId, currentStep });
          return await this.completeOnboarding(user, platform, state!);
      }
    } catch (error) {
      logger.error('Error processing onboarding step:', { userId, step: currentStep, error });
      await this.sendRecoveryMessage(userId, platform);
      throw error;
    }
  }

  /**
   * STEP 1: Welcome the user and start the level test.
   */
  private async handleWelcomeStep(user: any, platform: Platform) {
    const welcomeMessage = `¡Hola ${user.firstName}! 👋 Welcome to your English learning journey! I'm Alex, your personal AI English teacher.

Para darte la mejor experiencia, primero haremos una breve evaluación conversacional para conocer tu nivel de inglés. Es muy sencillo, solo responde a mis preguntas hablando en inglés.

¿Listo? Empecemos.

🎯 **Please introduce yourself. Tell me your name, where you're from, and one thing you enjoy doing.**`;

    await this.sendMessage(user.id, platform, welcomeMessage);

    const now = new Date();
    const state: OnboardingState = {
      step: 'level_test',
      testQuestions: this.getLevelTestQuestions(),
      currentQuestionIndex: 0,
      responses: [],
      startedAt: now,
      createdAt: now,
      updatedAt: now
    };

    await this.saveOnboardingState(user.id, state);
    await this.updateUserOnboardingStep(user.id, 'level_test');

    return { success: true, nextStep: 'level_test' };
  }

  /**
   * STEP 2: Handle the level test questions and answers.
   */
  private async handleLevelTestStep(user: any, input: string, platform: Platform, state: OnboardingState) {
    const transcription = await this.transcribeInput(input, user.id);
    const currentQuestion = state.testQuestions![state.currentQuestionIndex!];
    
    const evaluation = await this.evaluateResponse(transcription, currentQuestion.level);
    state.responses!.push({ question: currentQuestion.question, transcription, evaluation });

    const nextQuestionIndex = state.currentQuestionIndex! + 1;

    if (nextQuestionIndex >= state.testQuestions!.length) {
      // Test is complete, move to interests step
      const determinedLevel = this.calculateLevelFromResponses(state.responses!);
      state.determinedLevel = determinedLevel;
      
      await prisma.user.update({ where: { id: user.id }, data: { cefrLevel: determinedLevel } });
      await this.saveLevelTest(user.id, state.responses!, determinedLevel);

      const interestsMessage = `Great job! 🎉 Based on your responses, I've determined your English level is: **${determinedLevel}** (${this.getLevelDescription(determinedLevel)})

Now, to make your lessons fun, what topics are you interested in? You can say things like:

*   Technology & Science
*   Movies & TV Shows
*   Sports & Fitness
*   Travel & Culture
*   Business & Careers`;

      await this.sendMessage(user.id, platform, interestsMessage);
      
      state.step = 'interests';
      await this.saveOnboardingState(user.id, state);
      await this.updateUserOnboardingStep(user.id, 'interests');
      
      return { success: true, nextStep: 'interests', determinedLevel };

    } else {
      // Ask the next question
      const nextQuestion = state.testQuestions![nextQuestionIndex];
      await this.sendMessage(user.id, platform, `Thanks! Next question:\n\n🎯 **${nextQuestion.question}**`);
      
      state.currentQuestionIndex = nextQuestionIndex;
      await this.saveOnboardingState(user.id, state);

      return { success: true, nextStep: 'level_test' };
    }
  }

  /**
   * STEP 3: Handle the user's interests.
   */
  private async handleInterestsStep(user: any, input: string, platform: Platform, state: OnboardingState) {
    const transcription = await this.transcribeInput(input, user.id);
    const interests = this.extractInterests(transcription);
    
    await prisma.user.update({ where: { id: user.id }, data: { interests } });

    const goalMessage = `Perfect, interests noted: *${interests.join(', ')}*. ✨

One last thing! What's your main goal for learning English? For example:

*   To get a better job
*   For traveling
*   To talk with friends
*   For academic studies`;

    await this.sendMessage(user.id, platform, goalMessage);

    state.step = 'goal';
    state.interests = interests;
    await this.saveOnboardingState(user.id, state);
    await this.updateUserOnboardingStep(user.id, 'goal');

    return { success: true, nextStep: 'goal', interests };
  }

  /**
   * STEP 4: Handle the user's learning goal and complete onboarding.
   */
  private async handleGoalStep(user: any, input: string, platform: Platform, state: OnboardingState) {
    const transcription = await this.transcribeInput(input, user.id);
    const goal = this.extractLearningGoal(transcription);

    await prisma.user.update({ where: { id: user.id }, data: { learningGoal: goal } });
    
    state.goal = goal;
    return await this.completeOnboarding(user, platform, state);
  }

  /**
   * FINAL STEP: Complete the onboarding process.
   */
  private async completeOnboarding(user: any, platform: Platform, state: OnboardingState) {
    const finalUser = await prisma.user.findUnique({ where: { id: user.id } });

    const completionMessage = `Excellent! Your learning profile is all set. 🚀

**📊 Your Profile:**
*   **Level:** ${finalUser!.cefrLevel}
*   **Interests:** ${finalUser!.interests.join(', ')}
*   **Goal:** ${finalUser!.learningGoal}

Now you're ready to start practicing! Just send me a voice message in English about anything you like. I'll listen, evaluate, and give you personalized feedback.

Let's begin your English journey! 💪`;

    await this.sendMessage(user.id, platform, completionMessage);

    await prisma.user.update({
      where: { id: user.id },
      data: { isOnboarding: false, onboardingStep: 'complete' }
    });

    await this.clearOnboardingState(user.id);
    logUserAction(user.id, 'onboarding_completed', { level: finalUser!.cefrLevel, interests: finalUser!.interests, goal: finalUser!.learningGoal });

    return { success: true, onboardingComplete: true };
  }

  // --- Helper and Utility Methods ---

  private async transcribeInput(input: string, userId: string): Promise<string> {
    // In a real scenario, this would handle audio file paths and call a speech-to-text API.
    // For this simulation, we assume the input is already text (e.g., from a webhook that did transcription).
    logger.info('Transcribing input for user', { userId });
    return input;
  }

  private async evaluateResponse(transcription: string, level: string): Promise<any> {
    try {
      const prompt = await prisma.prompt.findUnique({ where: { id: 'all-speech_evaluation-evaluator' } });
      if (!prompt) throw new Error('Speech evaluation prompt not found');

      const completion = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [
          { role: "system", content: prompt.systemMessage },
          { role: "user", content: `Student CEFR Level: ${level}\nText to evaluate: "${transcription}"` }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      });

      const jsonResponse = completion.choices[0].message.content;
      return JSON.parse(jsonResponse!);
    } catch (error) {
      logger.error('Failed to evaluate response with AI, using fallback.', { error });
      return { overall: 60, feedback: { overall: "Could not evaluate." } };
    }
  }

  private getLevelTestQuestions() {
    // In a real app, these could be fetched from a `questions` table.
    // For now, keeping them here is a good balance for this refactor.
    return [
      { level: 'A1', question: "Please introduce yourself. Tell me your name, where you're from, and one thing you enjoy doing." },
      { level: 'A2', question: "Describe your typical day. What do you usually do from morning to evening?" },
      { level: 'B1', question: "Tell me about a memorable trip or experience you've had. What happened and how did you feel?" },
      { level: 'B2', question: "What is your opinion on the impact of technology on society? Please give some examples." },
      { level: 'C1', question: "Discuss a global issue that you think is important and suggest some possible solutions." }
    ];
  }

  private calculateLevelFromResponses(responses: any[]): string {
    const averageScore = responses.reduce((sum, r) => sum + r.evaluation.overall, 0) / responses.length;
    for (const level of CEFR_LEVELS) {
      if (averageScore >= level.minScore && averageScore <= level.maxScore) {
        return level.code;
      }
    }
    return 'A1'; // Default fallback
  }

  private extractInterests(text: string): string[] {
    const found = new Set<string>();
    const lowerText = text.toLowerCase();
    const interestMap: { [key: string]: string[] } = {
      'Technology': ['technology', 'tech', 'computer', 'software', 'ai'],
      'Movies & TV': ['movies', 'film', 'series', 'tv show', 'cinema'],
      'Sports': ['sports', 'football', 'soccer', 'basketball', 'fitness'],
      'Travel': ['travel', 'culture', 'countries', 'trip', 'vacation'],
      'Business': ['business', 'career', 'work', 'job', 'finance']
    };
    for (const [interest, keywords] of Object.entries(interestMap)) {
      if (keywords.some(kw => lowerText.includes(kw))) {
        found.add(interest);
      }
    }
    return found.size > 0 ? Array.from(found) : ['General'];
  }

  private extractLearningGoal(text: string): string {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('job') || lowerText.includes('career') || lowerText.includes('work')) return 'Career';
    if (lowerText.includes('travel') || lowerText.includes('trip')) return 'Travel';
    if (lowerText.includes('study') || lowerText.includes('academic') || lowerText.includes('school')) return 'Academic';
    if (lowerText.includes('friend') || lowerText.includes('talk') || lowerText.includes('conversation')) return 'Conversation';
    return 'General Improvement';
  }

  private getLevelDescription(level: string): string {
    return CEFR_LEVELS.find(l => l.code === level)?.description || 'Beginner';
  }

  private async saveLevelTest(userId: string, responses: any[], resultLevel: string) {
    const overallScore = responses.reduce((sum, r) => sum + r.evaluation.overall, 0) / responses.length;
    await prisma.levelTest.create({
      data: {
        userId,
        testType: 'initial',
        resultLevel,
        questions: responses.map(r => r.question),
        responses: responses,
        overallScore,
        completed: true,
        completedAt: new Date()
      }
    });
  }

  private async sendMessage(userId: string, platform: Platform, text: string) {
    try {
      await messagingGatewayService.sendMessage(userId, platform, undefined, text);
    } catch (error) {
      logger.error('Failed to send onboarding message', { userId, platform, error });
    }
  }
  
  private async sendRecoveryMessage(userId: string, platform: Platform) {
    await this.sendMessage(userId, platform, "I'm sorry, we hit a small snag. Let's try that again!");
  }

  private async getOnboardingState(userId: string): Promise<OnboardingState | null> {
    const key = `onboarding:${userId}`;
    let state = await redisManager.getJSON<OnboardingState>(key);
    if (state) return state;

    // Fallback to DB if Redis fails (implementing H-4)
    const dbState = await prisma.onboardingState.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    if (dbState) {
      state = dbState.state as OnboardingState;
      await this.saveOnboardingState(userId, state); // Re-hydrate Redis
      return state;
    }
    return null;
  }

  private async saveOnboardingState(userId: string, state: OnboardingState): Promise<void> {
    state.updatedAt = new Date();
    const key = `onboarding:${userId}`;
    await redisManager.setJSON(key, state, this.ONBOARDING_TTL);
    // Persist to DB for resilience (implementing H-4)
    await prisma.onboardingState.create({
      data: {
        userId,
        state: state as any,
        expiresAt: new Date(Date.now() + this.ONBOARDING_TTL * 1000)
      }
    });
  }

  private async clearOnboardingState(userId: string): Promise<void> {
    await redisManager.del(`onboarding:${userId}`);
    await prisma.onboardingState.deleteMany({ where: { userId } });
  }

  private async updateUserOnboardingStep(userId: string, step: string): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { onboardingStep: step } });
  }
}

export const onboardingService = new OnboardingService();
