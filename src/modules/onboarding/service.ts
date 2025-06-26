import prisma from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { CEFR_LEVELS, OnboardingState } from '../../types/index.js';
import { createError } from '../../middleware/errorHandler.js';
import axios from 'axios';

export class OnboardingService {
  private readonly baseURL = process.env.API_BASE_URL || 'http://localhost:3000';
  private readonly internalApiKey = process.env.INTERNAL_API_KEY!;

  async processOnboardingStep(userId: string, input: string, currentStep: string, platform: string) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw createError('User not found', 404);
      }

      logger.info(`Processing onboarding step: ${currentStep} for user: ${userId}`);

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
      logger.error('Error processing onboarding step:', error);
      throw error;
    }
  }

  private async handleWelcomeStep(user: any, input: string, platform: string) {
    // Send welcome message and start level test
    const welcomeMessage = `¡Hola ${user.firstName}! 👋 

Welcome to your English learning journey! I'm Alex, your AI English teacher.

To give you the best learning experience, I need to assess your current English level. I'll ask you a few questions - just answer naturally by speaking in English.

Ready? Let's start with an easy one:

🎯 Please introduce yourself. Tell me your name, where you're from, and one thing you enjoy doing.`;

    await this.sendMessage(user.id, platform, undefined, welcomeMessage);

    // Update user to level_test step
    await this.updateUserOnboardingStep(user.id, 'level_test', {
      testQuestions: this.getLevelTestQuestions(),
      currentQuestion: 0,
      responses: []
    });

    return {
      success: true,
      nextStep: 'level_test',
      message: 'Welcome message sent, level test started'
    };
  }

  private async handleLevelTestStep(user: any, input: string, platform: string) {
    // Get current test state
    const testState = this.getTestStateFromUser(user);
    const questions = testState.testQuestions || this.getLevelTestQuestions();
    const currentQuestion = testState.currentQuestion || 0;
    const responses = testState.responses || [];

    // Mock transcription for development
    const transcription = input.includes('mock') 
      ? "Hi, my name is John and I'm from Mexico. I enjoy reading books and playing soccer with my friends."
      : await this.transcribeAudio(input);

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
      // Calculate final level
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

      return {
        success: true,
        nextStep: 'interests',
        levelDetermined: finalLevel,
        message: 'Level test completed, interests selection started'
      };
    } else {
      // Ask next question
      const nextQuestionText = questions[nextQuestion].question;
      
      await this.updateUserOnboardingStep(user.id, 'level_test', {
        testQuestions: questions,
        currentQuestion: nextQuestion,
        responses
      });

      await this.sendMessage(user.id, platform, undefined, `Great! Next question:\n\n🎯 ${nextQuestionText}`);

      return {
        success: true,
        nextStep: 'level_test',
        currentQuestion: nextQuestion,
        message: 'Next question sent'
      };
    }
  }

  private async handleInterestsStep(user: any, input: string, platform: string) {
    // Mock transcription for development
    const transcription = input.includes('mock')
      ? "I'm interested in technology, movies, and sports"
      : await this.transcribeAudio(input);

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

    return {
      success: true,
      nextStep: 'goal',
      interests,
      message: 'Interests saved, goal selection started'
    };
  }

  private async handleGoalStep(user: any, input: string, platform: string) {
    // Mock transcription for development
    const transcription = input.includes('mock')
      ? "My goal is career advancement and business communication"
      : await this.transcribeAudio(input);

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
• Interests: ${user.interests.join(', ')}
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

    return {
      success: true,
      nextStep: 'complete',
      onboardingComplete: true,
      message: 'Onboarding completed successfully'
    };
  }

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

  private async evaluateResponse(transcription: string, question: any) {
    // Mock evaluation - in production, this would call the actual evaluation API
    const wordCount = transcription.split(' ').length;
    const expectedLength = question.expectedLength;
    
    const lengthScore = Math.min(100, (wordCount / expectedLength) * 100);
    const complexityScore = this.assessComplexity(transcription);
    const grammarScore = Math.random() * 40 + 60; // Mock score 60-100
    
    const overallScore = (lengthScore + complexityScore + grammarScore) / 3;

    return {
      overall: Math.round(overallScore),
      length: Math.round(lengthScore),
      complexity: Math.round(complexityScore),
      grammar: Math.round(grammarScore),
      wordCount,
      transcription
    };
  }

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

  private async saveLevelTest(userId: string, responses: any[], resultLevel: string) {
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
  }

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

  private getLevelDescription(level: string): string {
    const levelData = CEFR_LEVELS.find(l => l.code === level);
    return levelData ? levelData.description : 'English learner';
  }

  private getTestStateFromUser(user: any): any {
    // In a real implementation, this would be stored in Redis or database
    // For now, we'll use a simple approach
    return {
      testQuestions: this.getLevelTestQuestions(),
      currentQuestion: 0,
      responses: []
    };
  }

  private async updateUserOnboardingStep(userId: string, step: string, data?: any) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        onboardingStep: step,
        updatedAt: new Date()
      }
    });

    // In production, store the onboarding state in Redis
    logger.info(`Updated onboarding step for user ${userId}: ${step}`);
  }

  private async transcribeAudio(audioInput: string): Promise<string> {
    // Mock transcription - in production, this would call OpenAI Whisper
    return "This is a mock transcription of the user's audio input for development purposes.";
  }

  private async sendMessage(userId: string, platform: string, audioUrl?: string, text?: string) {
    try {
      await axios.post(`${this.baseURL}/api/gateway/send-message`, {
        userId,
        platform,
        audioUrl,
        text
      }, {
        headers: { 'x-api-key': this.internalApiKey }
      });
    } catch (error) {
      logger.error('Error sending onboarding message:', error);
    }
  }
}

export const onboardingService = new OnboardingService();