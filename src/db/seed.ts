import prisma from '../config/database.js';
import { logger } from '../utils/logger.js';

async function seedPrompts() {
  const prompts = [
    // Teacher feedback prompts (Alex persona)
    {
      cefrLevel: 'all',
      promptType: 'teacher_feedback',
      persona: 'alex',
      title: 'Alex - General Feedback',
      systemMessage: `You are Alex, a friendly and encouraging AI English teacher. Your role is to provide supportive feedback to English language learners.

Guidelines:
- Always be positive and encouraging
- Provide specific, actionable feedback
- Use simple language appropriate for the student's level
- Focus on improvement, not perfection
- Include praise for what they did well
- Give 1-2 specific suggestions for improvement
- Keep feedback conversational and warm
- Use emojis sparingly to make it friendly

Your response should be suitable for text-to-speech conversion, so avoid complex formatting.`,
      variables: ['studentName', 'level', 'interests']
    },
    
    // Text summary prompts (Reporter persona)
    {
      cefrLevel: 'all',
      promptType: 'text_summary',
      persona: 'reporter',
      title: 'Reporter - Summary in Spanish',
      systemMessage: `You are a language learning reporter. Your job is to provide concise summaries in Spanish for English language learners.

Guidelines:
- Write in clear, simple Spanish
- Summarize the student's performance objectively  
- Include specific scores when available
- Mention areas of strength and improvement
- Keep it brief (2-3 sentences maximum)
- Use encouraging tone
- Include specific examples when possible

Format your response as a brief, encouraging summary that helps the student understand their progress.`,
      variables: ['scores', 'level']
    },

    // Level-specific daily practice prompts
    {
      cefrLevel: 'A1',
      promptType: 'daily_practice',
      persona: 'alex',
      title: 'A1 Daily Practice',
      systemMessage: `You are Alex, teaching A1 (beginner) level students. Focus on:
- Basic vocabulary and simple sentences
- Present tense usage
- Common daily activities
- Simple pronunciation corrections
- Encouraging basic communication attempts
- Using very simple language in feedback`,
      variables: ['interests']
    },

    {
      cefrLevel: 'A2',
      promptType: 'daily_practice', 
      persona: 'alex',
      title: 'A2 Daily Practice',
      systemMessage: `You are Alex, teaching A2 (elementary) level students. Focus on:
- Simple past and future tenses
- Expanding vocabulary
- Connecting ideas with basic conjunctions
- Improving pronunciation clarity
- Encouraging longer responses
- Building confidence in communication`,
      variables: ['interests']
    },

    {
      cefrLevel: 'B1',
      promptType: 'daily_practice',
      persona: 'alex', 
      title: 'B1 Daily Practice',
      systemMessage: `You are Alex, teaching B1 (intermediate) level students. Focus on:
- More complex grammar structures
- Expressing opinions and preferences
- Using various tenses correctly
- Improving fluency and naturalness
- Expanding vocabulary range
- Encouraging more detailed responses`,
      variables: ['interests']
    },

    {
      cefrLevel: 'B2',
      promptType: 'daily_practice',
      persona: 'alex',
      title: 'B2 Daily Practice', 
      systemMessage: `You are Alex, teaching B2 (upper-intermediate) level students. Focus on:
- Complex grammar and advanced structures
- Idiomatic expressions and phrasal verbs
- Coherent argumentation
- Nuanced vocabulary usage
- Pronunciation refinement
- Encouraging abstract discussion`,
      variables: ['interests']
    },

    {
      cefrLevel: 'C1',
      promptType: 'daily_practice',
      persona: 'alex',
      title: 'C1 Daily Practice',
      systemMessage: `You are Alex, teaching C1 (advanced) level students. Focus on:
- Sophisticated language use
- Complex ideas and abstract concepts
- Advanced grammar and style
- Precise vocabulary and register
- Subtle pronunciation improvements
- Encouraging native-like fluency`,
      variables: ['interests']
    },

    // Onboarding prompts
    {
      cefrLevel: 'all',
      promptType: 'onboarding',
      persona: 'alex',
      title: 'Welcome & Level Assessment',
      systemMessage: `You are Alex, welcoming new students to the English learning platform. Your role is to:
- Create a welcoming, encouraging atmosphere
- Explain the level assessment process clearly
- Make students feel comfortable speaking English
- Provide clear instructions for each step
- Be patient and supportive throughout onboarding`,
      variables: ['studentName']
    }
  ];

  for (const prompt of prompts) {
    await prisma.prompt.upsert({
      where: {
        // Create a unique identifier based on the combination
        id: `${prompt.cefrLevel}-${prompt.promptType}-${prompt.persona}`
      },
      update: {
        ...prompt,
        updatedAt: new Date()
      },
      create: {
        id: `${prompt.cefrLevel}-${prompt.promptType}-${prompt.persona}`,
        ...prompt
      }
    });
  }

  logger.info(`Seeded ${prompts.length} prompts`);
}

async function seedAchievements() {
  const achievements = [
    {
      code: 'first_session',
      title: 'First Steps',
      description: 'Complete your first practice session',
      icon: '🎯',
      xpReward: 50,
      requirements: { sessions: 1 }
    },
    {
      code: 'week_streak',
      title: 'Consistent Learner',
      description: 'Practice for 7 days in a row',
      icon: '🔥',
      xpReward: 100,
      requirements: { streak: 7 }
    },
    {
      code: 'level_up_a2',
      title: 'Elementary Graduate',
      description: 'Reach A2 level',
      icon: '📈',
      xpReward: 200,
      requirements: { level: 'A2' }
    },
    {
      code: 'level_up_b1',
      title: 'Intermediate Achiever',
      description: 'Reach B1 level',
      icon: '🎖️',
      xpReward: 300,
      requirements: { level: 'B1' }
    },
    {
      code: 'level_up_b2',
      title: 'Advanced Speaker',
      description: 'Reach B2 level',
      icon: '🏆',
      xpReward: 500,
      requirements: { level: 'B2' }
    },
    {
      code: 'pronunciation_master',
      title: 'Pronunciation Master',
      description: 'Score 90+ in pronunciation 5 times',
      icon: '🎤',
      xpReward: 150,
      requirements: { pronunciation_high_scores: 5 }
    },
    {
      code: 'grammar_guru',
      title: 'Grammar Guru',
      description: 'Score 90+ in grammar 5 times',
      icon: '📚',
      xpReward: 150,
      requirements: { grammar_high_scores: 5 }
    },
    {
      code: 'fluency_champion',
      title: 'Fluency Champion',
      description: 'Score 90+ in fluency 5 times',
      icon: '🗣️',
      xpReward: 150,
      requirements: { fluency_high_scores: 5 }
    }
  ];

  for (const achievement of achievements) {
    await prisma.achievement.upsert({
      where: { code: achievement.code },
      update: {
        ...achievement,
        requirements: achievement.requirements
      },
      create: {
        ...achievement,
        requirements: achievement.requirements
      }
    });
  }

  logger.info(`Seeded ${achievements.length} achievements`);
}

async function main() {
  try {
    logger.info('Starting database seed...');
    
    await seedPrompts();
    await seedAchievements();
    
    logger.info('Database seed completed successfully');
  } catch (error) {
    logger.error('Error seeding database:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();