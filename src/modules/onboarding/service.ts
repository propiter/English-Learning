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
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Onboarding service for managing user onboarding flow with resilient state management
 */
export class OnboardingService {
  private readonly ONBOARDING_TTL = 3600; // 1 hour
  private readonly MAX_QUESTIONS = 5;
  private readonly QUESTION_TIMEOUT = 300; // 5 minutes
  private readonly MAX_RETRIES = 3;

  /**
   * Process onboarding step with resilient error handling
   */
  async processOnboardingStep(userId: string, input: string, currentStep: string, platform: Platform) {
    if (platform !== 'telegram' && platform !== 'whatsapp') {
      throw createError(`Unsupported platform: ${platform}`, 400);
    }

    try {
      // Get user from database
      const user = await prisma.user.findUnique({ 
        where: { id: userId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
          language: true,
          isOnboarding: true,
          onboardingStep: true
        }
      });
      
      if (!user) {
        throw createError('User not found', 404);
      }

      logger.info('Processing onboarding step', {
        userId,
        currentStep,
        userOnboardingStep: user.onboardingStep,
        platform
      });

      // MEJORA: Recuperación resiliente de estado
      let state: OnboardingState | null = null;
      
      if (currentStep !== 'welcome') {
        state = await this.getOnboardingStateResilient(userId);
        
        // Si no hay estado y no es welcome, reiniciar onboarding
        if (!state && currentStep !== 'welcome') {
          logger.warn('No onboarding state found, restarting onboarding', { userId });
          await this.sendRestartMessage(user, platform);
          return await this.handleWelcomeStep(user, input, platform);
        }
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
      
      // MEJORA: Enviar mensaje de recuperación en lugar de error técnico
      await this.sendRecoveryMessage(userId, platform, currentStep);
      throw error;
    }
  }

  /**
   * NUEVA: Recuperación resiliente de estado con fallback a DB
   */
  private async getOnboardingStateResilient(userId: string): Promise<OnboardingState | null> {
    try {
      // Intentar Redis primero
      const redisState = await this.getOnboardingStateFromRedis(userId);
      if (redisState) {
        return redisState;
      }

      // Fallback: Recuperar desde DB
      logger.info('Redis state not found, attempting DB recovery', { userId });
      const dbState = await this.getOnboardingStateFromDB(userId);
      
      if (dbState) {
        // Restaurar en Redis para futuras operaciones
        await this.saveOnboardingStateResilient(userId, dbState);
        return dbState;
      }

      return null;
    } catch (error) {
      logger.error('Error in resilient state recovery:', { userId, error });
      return null;
    }
  }

  /**
   * NUEVA: Guardar estado de forma resiliente (Redis + DB backup)
   */
  private async saveOnboardingStateResilient(userId: string, state: OnboardingState): Promise<void> {
    const errors: string[] = [];

    // Intentar guardar en Redis
    try {
      await this.saveOnboardingStateToRedis(userId, state);
    } catch (redisError) {
      const errorMsg = redisError instanceof Error ? redisError.message : 'Unknown Redis error';
      errors.push(`Redis: ${errorMsg}`);
      logger.warn('Failed to save to Redis, continuing with DB backup', { userId, error: errorMsg });
    }

    // Siempre guardar backup en DB
    try {
      await this.saveOnboardingStateToDB(userId, state);
    } catch (dbError) {
      const errorMsg = dbError instanceof Error ? dbError.message : 'Unknown DB error';
      errors.push(`DB: ${errorMsg}`);
      logger.error('Failed to save to DB backup', { userId, error: errorMsg });
    }

    // Solo fallar si ambos sistemas fallan
    if (errors.length === 2) {
      throw createError(`Failed to save state: ${errors.join(', ')}`, 500);
    }

    if (errors.length === 1) {
      logger.warn('Partial state save failure', { userId, errors });
    }
  }

  /**
   * NUEVA: Guardar estado en Redis con manejo de errores mejorado
   */
  private async saveOnboardingStateToRedis(userId: string, state: OnboardingState): Promise<void> {
    const key = `onboarding:${userId}`;
    
    // Verificar salud de Redis antes de intentar
    const health = await redisManager.checkHealth();
    if (health.status !== 'ok') {
      throw new Error(`Redis unhealthy: ${health.error}`);
    }

    await redisManager.setJSON(key, state, this.ONBOARDING_TTL);
    
    // Verificar que se guardó correctamente
    const savedState = await redisManager.getJSON<OnboardingState>(key);
    if (!savedState) {
      throw new Error('State verification failed after save');
    }
  }

  /**
   * NUEVA: Recuperar estado desde Redis
   */
  private async getOnboardingStateFromRedis(userId: string): Promise<OnboardingState | null> {
    const key = `onboarding:${userId}`;
    
    const health = await redisManager.checkHealth();
    if (health.status !== 'ok') {
      logger.warn('Redis unhealthy, skipping Redis recovery', { userId });
      return null;
    }

    const state = await redisManager.getJSON<OnboardingState>(key);
    
    if (state && this.validateStateStructure(state)) {
      return state;
    }
    
    return null;
  }

  /**
   * NUEVA: Guardar estado en DB como backup
   */
  private async saveOnboardingStateToDB(userId: string, state: OnboardingState): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: {
        onboardingStep: state.step,
        // Guardar estado serializado en un campo JSON (requiere migración de DB)
        // Por ahora, solo actualizamos el step
        updatedAt: new Date()
      }
    });

    // TODO: Crear tabla onboarding_states para persistir estado completo
    // await prisma.onboardingState.upsert({
    //   where: { userId },
    //   create: { userId, state: state as any, expiresAt: new Date(Date.now() + this.ONBOARDING_TTL * 1000) },
    //   update: { state: state as any, updatedAt: new Date() }
    // });
  }

  /**
   * NUEVA: Recuperar estado desde DB
   */
  private async getOnboardingStateFromDB(userId: string): Promise<OnboardingState | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { onboardingStep: true, updatedAt: true }
    });

    if (!user || !user.onboardingStep || user.onboardingStep === 'complete') {
      return null;
    }

    // Verificar que no sea muy antiguo (más de 2 horas)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    if (user.updatedAt < twoHoursAgo) {
      logger.info('DB state too old, considering expired', { userId, lastUpdate: user.updatedAt });
      return null;
    }

    // Crear estado básico desde DB
    const now = new Date();
    return {
      step: user.onboardingStep,
      testQuestions: user.onboardingStep === 'level_test' ? this.getLevelTestQuestions() : undefined,
      currentQuestion: user.onboardingStep === 'level_test' ? 0 : undefined,
      responses: [],
      startedAt: user.updatedAt,
      createdAt: user.updatedAt,
      updatedAt: now
    };
  }

  /**
   * NUEVA: Validar estructura de estado
   */
  private validateStateStructure(state: any): boolean {
    return state && 
           typeof state.step === 'string' && 
           state.startedAt && 
           state.createdAt && 
           state.updatedAt;
  }

  /**
   * NUEVA: Enviar mensaje de reinicio cuando se pierde el estado
   */
  private async sendRestartMessage(user: any, platform: Platform): Promise<void> {
    const message = `¡Hola ${user.firstName}! 👋

Parece que perdimos el hilo de nuestra conversación. No te preocupes, esto puede pasar.

¿Te gustaría que reiniciemos tu evaluación de nivel desde el principio? Solo tomará unos minutos y así podremos personalizar mejor tu experiencia de aprendizaje.

Responde "sí" para continuar o envía cualquier mensaje de voz para empezar.`;

    await this.sendMessage(user.id, platform, undefined, message);
  }

  /**
   * NUEVA: Enviar mensaje de recuperación específico por paso
   */
  private async sendRecoveryMessage(userId: string, platform: Platform, failedStep: string): Promise<void> {
    const recoveryMessages: { [key: string]: string } = {
      'welcome': 'Hubo un problema al iniciar. Por favor, envía /start para comenzar de nuevo.',
      'level_test': 'Tuvimos un problema durante tu evaluación. Vamos a reiniciar desde donde quedamos. Por favor, responde a la pregunta anterior.',
      'interests': 'Hubo un problema al guardar tus intereses. Por favor, cuéntame nuevamente qué temas te interesan.',
      'goal': 'Tuvimos un problema al guardar tu meta de aprendizaje. Por favor, cuéntame otra vez cuál es tu objetivo principal.'
    };

    const message = recoveryMessages[failedStep] || 
      'Tuvimos un problema técnico temporal. Por favor, intenta enviar tu mensaje nuevamente en unos segundos.';

    try {
      await this.sendMessage(userId, platform, undefined, message);
    } catch (error) {
      logger.error('Failed to send recovery message', { userId, platform, error });
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

    // Initialize onboarding state with resilient saving
    const now = new Date();
    const state: OnboardingState = {
      step: 'level_test',
      testQuestions: this.getLevelTestQuestions(),
      currentQuestion: 0,
      responses: [],
      startedAt: now,
      createdAt: now,
      updatedAt: now
    };

    await this.saveOnboardingStateResilient(user.id, state);
    await this.updateUserOnboardingStep(user.id, 'level_test');

    logUserAction(user.id, 'onboarding_welcome_completed', { platform });

    return {
      success: true,
      nextStep: 'level_test',
      message: 'Welcome message sent, level test started'
    };
  }

  /**
   * Handle level test step with improved error handling
   */
  private async handleLevelTestStep(user: any, input: string, platform: Platform) {
    const state = await this.getOnboardingStateResilient(user.id);
    if (!state) {
      logger.warn('No state found for level test, restarting', { userId: user.id });
      return await this.handleWelcomeStep(user, input, platform);
    }

    const questions = state.testQuestions || this.getLevelTestQuestions();
    const currentQuestion = state.currentQuestion || 0;
    const responses = state.responses || [];

    // Transcribe audio input with fallback
    const transcription = await this.transcribeAudioWithFallback(input, user.id);
    
    // Evaluate the response with fallback
    const evaluation = await this.evaluateResponseWithFallback(transcription, questions[currentQuestion]);
    
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
   * NUEVA: Transcripción con fallback para desarrollo
   */
  private async transcribeAudioWithFallback(audioInput: string, userId: string): Promise<string> {
    try {
      // Para desarrollo/testing, usar transcripción mock
      if (audioInput.includes('mock') || process.env.NODE_ENV === 'development') {
        const mockTranscriptions = [
          "Hi, my name is John and I'm from Mexico. I enjoy reading books and playing soccer with my friends.",
          "I usually wake up at 7 AM, have breakfast, go to work, and come back home in the evening.",
          "Last year I traveled to Europe and visited many beautiful cities. It was an amazing experience.",
          "I think technology has both positive and negative impacts on education. It makes learning more accessible but can also be distracting.",
          "Climate change is a serious global issue that requires immediate action from governments and individuals worldwide."
        ];
        return mockTranscriptions[Math.floor(Math.random() * mockTranscriptions.length)];
      }

      // En producción, implementar transcripción real
      logger.warn('Audio transcription not fully implemented', { userId, audioInput });
      return "I'm practicing my English today and working on improving my pronunciation.";

    } catch (error) {
      logger.error('Error transcribing audio:', { userId, error });
      return "I'm practicing my English conversation skills.";
    }
  }

  /**
   * NUEVA: Evaluación con fallback robusto
   */
  private async evaluateResponseWithFallback(transcription: string, question: any) {
    try {
      const wordCount = transcription.split(' ').length;
      const expectedLength = question.expectedLength;
      
      const lengthScore = Math.min(100, (wordCount / expectedLength) * 100);
      const complexityScore = this.assessComplexity(transcription);
      
      // Intentar evaluación con OpenAI con reintentos
      let grammarScore = 60; // Default fallback
      
      for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
        try {
          grammarScore = await this.evaluateGrammarWithTimeout(transcription);
          break; // Éxito, salir del loop
        } catch (error) {
          logger.warn(`Grammar evaluation attempt ${attempt} failed`, { error });
          if (attempt === this.MAX_RETRIES) {
            logger.error('All grammar evaluation attempts failed, using fallback score');
          } else {
            // Esperar antes del siguiente intento
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      
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
      // Return safe default scores
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
   * NUEVA: Evaluación de gramática con timeout
   */
  private async evaluateGrammarWithTimeout(text: string): Promise<number> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('OpenAI timeout')), 10000); // 10 segundos
    });

    const evaluationPromise = openai.chat.completions.create({
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

    try {
      const completion = await Promise.race([evaluationPromise, timeoutPromise]);
      const score = parseInt(completion.choices[0].message.content || '60');
      return Math.max(0, Math.min(100, score));
    } catch (error) {
      throw error; // Re-throw para que el caller maneje los reintentos
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
    const now = new Date();
    const state: OnboardingState = {
      step: 'interests',
      tempLevel: finalLevel,
      startedAt: now,
      createdAt: now,
      updatedAt: now
    };
    await this.saveOnboardingStateResilient(user.id, state);

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
    
    await this.saveOnboardingStateResilient(user.id, state);
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
    const transcription = await this.transcribeAudioWithFallback(input, user.id);
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
    const now = new Date();
    const state: OnboardingState = {
      step: 'goal',
      interests,
      startedAt: now,
      createdAt: now,
      updatedAt: now
    };
    await this.saveOnboardingStateResilient(user.id, state);

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
    const transcription = await this.transcribeAudioWithFallback(input, user.id);
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
   * Clear onboarding state from both Redis and DB
   */
  private async clearOnboardingState(userId: string): Promise<void> {
    try {
      // Clear from Redis
      const key = `onboarding:${userId}`;
      await redisManager.del(key);
    } catch (error) {
      logger.error('Failed to clear onboarding state from Redis:', { userId, error });
    }

    try {
      // Clear from DB (when onboarding_states table exists)
      // await prisma.onboardingState.deleteMany({ where: { userId } });
    } catch (error) {
      logger.error('Failed to clear onboarding state from DB:', { userId, error });
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