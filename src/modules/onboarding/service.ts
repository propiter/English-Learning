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
  currentQuestion?: number;
  responses?: any[];
  tempLevel?: string;
  interests?: string[];
  goal?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Onboarding service for managing user onboarding flow
 */
export class OnboardingService {
  private readonly ONBOARDING_TTL = 3600; // 1 hour
  private readonly MAX_QUESTIONS = 5;
  private readonly QUESTION_TIMEOUT = 300; // 5 minutes

  /**
   * Process onboarding step
   */
  async processOnboardingStep(userId: string, input: string, currentStep: string, platform: Platform) {
    if (platform !== 'telegram' && platform !== 'whatsapp') {
      throw createError(`Unsupported platform: ${platform}`, 400);
    }

    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw createError('User not found', 404);
      }

      logUserAction(userId, 'onboarding_step_started', { step: currentStep, platform });

      switch (currentStep) {
        case 'welcome':
          return await this.handleWelcomeStep(user, input, platform);
        
        case 'level_test':
          return await this.handleLevelTestStep(user, input, platform);
        
        case 'interests':
          return await this.handleInterestsStep(user, input, platform);
        
        case 'goal':
          return await this.handleGoalStep(user, input, platform);
        
        default:
          throw createError('Invalid onboarding step', 400);
      }
    } catch (error) {
      logger.error('Error processing onboarding step:', {
        userId,
        step: currentStep,
        platform,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Handle welcome step
   */
  private async handleWelcomeStep(user: any, _input: string, platform: Platform) {
    const firstName = user.firstName || 'there';
    
    const welcomeMessage = `¡Hola ${firstName}! 👋 

Welcome to your English learning journey! I'm Alex, your AI English teacher.

To give you the best learning experience, I need to assess your current English level. I'll ask you a few questions - just answer naturally by speaking in English.

Ready? Let's start with an easy one:

🎯 Please introduce yourself. Tell me your name, where you're from, and one thing you enjoy doing.`;

    await this.sendMessage(user.id, platform, undefined, welcomeMessage);

    // Initialize onboarding state
    const state: OnboardingState = {
      step: 'level_test',
      testQuestions: this.getLevelTestQuestions(),
      currentQuestion: 0,
      responses: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.saveOnboardingState(user.id, state);
    await this.updateUserOnboardingStep(user.id, 'level_test');

    logUserAction(user.id, 'onboarding_welcome_completed', { platform });

    return {
      success: true,
      nextStep: 'level_test',
      message: 'Welcome message sent, level test started'
    };
  }

  /**
   * Handle level test step
   */
  private async handleLevelTestStep(user: any, input: string, platform: Platform) {
    const state = await this.getOnboardingState(user.id);
    if (!state) {
      throw createError('Onboarding state not found', 404);
    }

    const questions = state.testQuestions || this.getLevelTestQuestions();
    const currentQuestion = state.currentQuestion || 0;
    const responses = state.responses || [];

    // Transcribe audio input
    const transcription = await this.transcribeAudio(input, user.id);
    
    // Evaluate the response
    const evaluation = await this.evaluateResponse(transcription, questions[currentQuestion]);
    
    // Store the response
    responses.push({
      question: questions[currentQuestion],
      transcription,
      evaluation,
      timestamp: new Date()
    });

    const nextQuestion = currentQuestion + 1;

    // Check if test is complete
    if (nextQuestion >= questions.length) {
      return await this.completeLevelTest(user, responses, platform);
    } else {
      return await this.askNextQuestion(user, state, questions, nextQuestion, responses, platform);
    }
  }

  /**
   * Complete level test
   */
  private async completeLevelTest(user: any, responses: any[], platform: Platform) {
    const finalLevel = this.calculateLevelFromResponses(responses);
    
    await this.saveLevelTest(user.id, responses, finalLevel);
    
    // Update user level and move to interests step
    await prisma.user.update({
      where: { id: user.id },
      data: {
        cefrLevel: finalLevel,
        onboardingStep: 'interests'
      }
    });

    const levelMessage = `Great job! 🎉 

Based on your responses, I've determined your English level is: **${finalLevel}** (${this.getLevelDescription(finalLevel)})

Now, let's personalize your learning experience. What topics interest you most? Please choose from these categories or tell me your own:

📚 Technology  
🎬 Movies & Entertainment  
⚽ Sports  
🍳 Food & Cooking  
✈️ Travel  
💼 Business  
🎵 Music  
📖 Books & Literature  

Just tell me 2-3 topics you'd like to practice English with!`;

    await this.sendMessage(user.id, platform, undefined, levelMessage);

    // Update onboarding state
    const state: OnboardingState = {
      step: 'interests',
      tempLevel: finalLevel,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await this.saveOnboardingState(user.id, state);

    logUserAction(user.id, 'level_test_completed', { level: finalLevel, platform });

    return {
      success: true,
      nextStep: 'interests',
      levelDetermined: finalLevel,
      message: 'Level test completed, interests selection started'
    };
  }

  /**
   * Ask next question in level test
   */
  private async askNextQuestion(user: any, state: OnboardingState, questions: any[], nextQuestion: number, responses: any[], platform: Platform) {
    const nextQuestionText = questions[nextQuestion].question;
    
    // Update state
    state.currentQuestion = nextQuestion;
    state.responses = responses;
    state.updatedAt = new Date();
    
    await this.saveOnboardingState(user.id, state);
    await this.sendMessage(user.id, platform, undefined, `Great! Next question:\n\n🎯 ${nextQuestionText}`);

    logUserAction(user.id, 'level_test_question_asked', { questionNumber: nextQuestion, platform });

    return {
      success: true,
      nextStep: 'level_test',
      currentQuestion: nextQuestion,
      message: 'Next question sent'
    };
  }

  /**
   * Handle interests step
   */
  private async handleInterestsStep(user: any, input: string, platform: Platform) {
    const transcription = await this.transcribeAudio(input, user.id);
    const interests = this.extractInterests(transcription);
    
    // Update user interests
    await prisma.user.update({
      where: { id: user.id },
      data: {
        interests,
        onboardingStep: 'goal'
      }
    });

    const goalMessage = `Perfect! I see you're interested in: ${interests.join(', ')} ✨

One last question to customize your experience:

🎯 What's your main goal for learning English?

📈 Career advancement / Business  
🌍 Travel and tourism  
🎓 Academic studies  
💬 General conversation skills  
🏠 Daily life communication  

Or tell me your specific goal!`;

    await this.sendMessage(user.id, platform, undefined, goalMessage);

    // Update onboarding state
    const state: OnboardingState = {
      step: 'goal',
      interests,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await this.saveOnboardingState(user.id, state);

    logUserAction(user.id, 'interests_selected', { interests, platform });

    return {
      success: true,
      nextStep: 'goal',
      interests,
      message: 'Interests saved, goal selection started'
    };
  }

  /**
   * Handle goal step
   */
  private async handleGoalStep(user: any, input: string, platform: Platform) {
    const transcription = await this.transcribeAudio(input, user.id);
    const goal = this.extractLearningGoal(transcription);
    
    // Complete onboarding
    await prisma.user.update({
      where: { id: user.id },
      data: {
        learningGoal: goal,
        isOnboarding: false,
        onboardingStep: 'complete'
      }
    });

    const completionMessage = `Excellent! 🚀 Your setup is complete!

📊 **Your Learning Profile:**
• Level: ${user.cefrLevel}
• Interests: ${user.interests?.join(', ') || 'General'}
• Goal: ${goal}

🎯 **What's Next:**
Now you can start practicing! Just send me voice messages in English anytime, and I'll:
• Evaluate your pronunciation, grammar, and fluency
• Give you personalized feedback
• Help you improve step by step
• Track your progress and XP

Ready to start your first practice session? Send me a voice message about any topic you like, or I can suggest one based on your interests!

¡Let's begin your English journey! 💪`;

    await this.sendMessage(user.id, platform, undefined, completionMessage);

    // Clear onboarding state
    await this.clearOnboardingState(user.id);

    logUserAction(user.id, 'onboarding_completed', { goal, platform });

    return {
      success: true,
      nextStep: 'complete',
      onboardingComplete: true,
      message: 'Onboarding completed successfully'
    };
  }

  /**
   * Save onboarding state to Redis
   */
  private async saveOnboardingState(userId: string, state: OnboardingState): Promise<void> {
    try {
      const key = `onboarding:${userId}`;
      await redisManager.setJSON(key, state, this.ONBOARDING_TTL);
    } catch (error) {
      logger.error('Failed to save onboarding state:', { userId, error });
      throw createError('Failed to save onboarding state', 500);
    }
  }

  /**
   * Get onboarding state from Redis
   */
  private async getOnboardingState(userId: string): Promise<OnboardingState | null> {
    try {
      const key = `onboarding:${userId}`;
      return await redisManager.getJSON<OnboardingState>(key);
    } catch (error) {
      logger.error('Failed to get onboarding state:', { userId, error });
      return null;
    }
  }

  /**
   * Clear onboarding state from Redis
   */
  private async clearOnboardingState(userId: string): Promise<void> {
    try {
      const key = `onboarding:${userId}`;
      await redisManager.del(key);
    } catch (error) {
      logger.error('Failed to clear onboarding state:', { userId, error });
    }
  }

  /**
   * Update user onboarding step in database
   */
  private async updateUserOnboardingStep(userId: string, step: string): Promise<void> {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: {
          onboardingStep: step,
          updatedAt: new Date()
        }
      });
    } catch (error) {
      logger.error('Failed to update user onboarding step:', { userId, step, error });
      throw createError('Failed to update onboarding step', 500);
    }
  }

  /**
   * Transcribe audio using OpenAI Whisper
   */
  private async transcribeAudio(audioInput: string, userId: string): Promise<string> {
    try {
      // For development/testing, check if it's a mock input
      if (audioInput.includes('mock') || process.env.NODE_ENV === 'development') {
        return "Hi, my name is John and I'm from Mexico. I enjoy reading books and playing soccer with my friends.";
      }

      // In production, this would handle actual audio file processing
      // For now, we'll use a placeholder implementation
      logger.warn('Audio transcription not fully implemented', { userId, audioInput });
      return "This is a placeholder transcription. Audio processing needs to be implemented.";

    } catch (error) {
      logger.error('Error transcribing audio:', { userId, error });
      throw createError('Failed to transcribe audio', 500);
    }
  }

  /**
   * Get level test questions
   */
  private getLevelTestQuestions() {
    return [
      {
        level: 'A1',
        question: "Please introduce yourself. Tell me your name, where you're from, and one thing you enjoy doing.",
        expectedLength: 20,
        criteria: ['basic_vocabulary', 'simple_sentences']
      },
      {
        level: 'A2',
        question: "Describe your typical day. What do you usually do from morning to evening?",
        expectedLength: 40,
        criteria: ['present_tense', 'time_expressions', 'daily_activities']
      },
      {
        level: 'B1',
        question: "Tell me about a memorable trip or experience you've had. What happened and how did you feel?",
        expectedLength: 60,
        criteria: ['past_tense', 'emotions', 'narrative_structure']
      },
      {
        level: 'B2',
        question: "What do you think about the impact of technology on education? Give your opinion and examples.",
        expectedLength: 80,
        criteria: ['opinion_expression', 'complex_sentences', 'examples']
      },
      {
        level: 'C1',
        question: "Discuss a global issue that concerns you and propose some solutions. Explain your reasoning.",
        expectedLength: 100,
        criteria: ['abstract_concepts', 'argumentation', 'complex_vocabulary']
      }
    ];
  }

  /**
   * Evaluate response using AI
   */
  private async evaluateResponse(transcription: string, question: any) {
    try {
      const wordCount = transcription.split(' ').length;
      const expectedLength = question.expectedLength;
      
      const lengthScore = Math.min(100, (wordCount / expectedLength) * 100);
      const complexityScore = this.assessComplexity(transcription);
      
      // Use OpenAI for grammar evaluation
      const grammarScore = await this.evaluateGrammar(transcription);
      
      const overallScore = (lengthScore + complexityScore + grammarScore) / 3;

      return {
        overall: Math.round(overallScore),
        length: Math.round(lengthScore),
        complexity: Math.round(complexityScore),
        grammar: Math.round(grammarScore),
        wordCount,
        transcription
      };
    } catch (error) {
      logger.error('Error evaluating response:', { transcription, error });
      // Return default scores if evaluation fails
      return {
        overall: 60,
        length: 60,
        complexity: 60,
        grammar: 60,
        wordCount: transcription.split(' ').length,
        transcription
      };
    }
  }

  /**
   * Evaluate grammar using OpenAI
   */
  private async evaluateGrammar(text: string): Promise<number> {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: "You are an English grammar evaluator. Rate the grammar quality of the given text on a scale of 0-100. Consider sentence structure, verb tenses, subject-verb agreement, and overall grammatical correctness. Respond only with a number."
          },
          {
            role: "user",
            content: text
          }
        ],
        max_tokens: 10,
        temperature: 0.1
      });

      const score = parseInt(completion.choices[0].message.content || '60');
      return Math.max(0, Math.min(100, score));
    } catch (error) {
      logger.error('Error evaluating grammar with OpenAI:', error);
      return 60; // Default score
    }
  }

  /**
   * Assess text complexity
   */
  private assessComplexity(text: string): number {
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const avgWordsPerSentence = text.split(' ').length / sentences.length;
    
    let complexityScore = 50; // Base score
    
    // Longer sentences suggest higher complexity
    if (avgWordsPerSentence > 15) complexityScore += 20;
    else if (avgWordsPerSentence > 10) complexityScore += 10;
    
    // Look for complex structures
    if (text.includes(' which ') || text.includes(' that ')) complexityScore += 10;
    if (text.includes(' because ') || text.includes(' although ')) complexityScore += 10;
    if (text.includes(' however ') || text.includes(' therefore ')) complexityScore += 15;
    
    return Math.min(100, complexityScore);
  }

  /**
   * Calculate CEFR level from responses
   */
  private calculateLevelFromResponses(responses: any[]): string {
    const scores = responses.map(r => r.evaluation.overall);
    const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    
    // Determine level based on average score
    for (const level of CEFR_LEVELS) {
      if (averageScore >= level.minScore && averageScore <= level.maxScore) {
        return level.code;
      }
    }
    
    return 'A1'; // Default fallback
  }

  /**
   * Save level test results
   */
  private async saveLevelTest(userId: string, responses: any[], resultLevel: string) {
    try {
      const questions = responses.map(r => r.question);
      const testResponses = responses.map(r => ({
        transcription: r.transcription,
        evaluation: r.evaluation,
        timestamp: r.timestamp
      }));
      
      const overallScore = responses.reduce((sum, r) => sum + r.evaluation.overall, 0) / responses.length;

      await prisma.levelTest.create({
        data: {
          userId,
          testType: 'initial',
          resultLevel,
          questions,
          responses: testResponses,
          overallScore,
          completed: true,
          completedAt: new Date()
        }
      });

      logUserAction(userId, 'level_test_saved', { level: resultLevel, score: overallScore });
    } catch (error) {
      logger.error('Error saving level test:', { userId, error });
      throw createError('Failed to save level test', 500);
    }
  }

  /**
   * Extract interests from transcription
   */
  private extractInterests(transcription: string): string[] {
    const interestMap: { [key: string]: string[] } = {
      'technology': ['technology', 'tech', 'computer', 'software', 'programming', 'coding'],
      'movies': ['movies', 'films', 'cinema', 'entertainment', 'tv', 'series'],
      'sports': ['sports', 'football', 'soccer', 'basketball', 'tennis', 'running', 'gym'],
      'food': ['food', 'cooking', 'cuisine', 'recipes', 'restaurant', 'eating'],
      'travel': ['travel', 'tourism', 'countries', 'places', 'vacation', 'trip'],
      'business': ['business', 'work', 'career', 'finance', 'marketing', 'management'],
      'music': ['music', 'songs', 'concert', 'band', 'singing', 'instruments'],
      'books': ['books', 'reading', 'literature', 'novels', 'stories', 'writing']
    };

    const text = transcription.toLowerCase();
    const foundInterests: string[] = [];

    Object.entries(interestMap).forEach(([interest, keywords]) => {
      if (keywords.some(keyword => text.includes(keyword))) {
        foundInterests.push(interest);
      }
    });

    return foundInterests.length > 0 ? foundInterests : ['general'];
  }

  /**
   * Extract learning goal from transcription
   */
  private extractLearningGoal(transcription: string): string {
    const text = transcription.toLowerCase();
    
    if (text.includes('career') || text.includes('business') || text.includes('work')) {
      return 'business';
    } else if (text.includes('travel') || text.includes('tourism')) {
      return 'travel';
    } else if (text.includes('academic') || text.includes('study') || text.includes('university')) {
      return 'academic';
    } else if (text.includes('conversation') || text.includes('speaking')) {
      return 'conversation';
    } else {
      return 'general';
    }
  }

  /**
   * Get level description
   */
  private getLevelDescription(level: string): string {
    const levelData = CEFR_LEVELS.find(l => l.code === level);
    return levelData ? levelData.description : 'English learner';
  }

  /**
   * Send message to user
   */
  private async sendMessage(userId: string, platform: Platform, audioUrl?: string, text?: string) {
    if (!text && !audioUrl) {
      logger.warn('No content provided for message', { userId });
      return;
    }

    try {
      await messagingGatewayService.sendMessage(userId, platform, audioUrl, text);
      logUserAction(userId, 'message_sent', { platform, hasAudio: !!audioUrl, hasText: !!text });
    } catch (error) {
      logger.error('Error sending onboarding message:', { userId, platform, error });
      throw createError('Failed to send message', 500);
    }
  }
}

export const onboardingService = new OnboardingService();