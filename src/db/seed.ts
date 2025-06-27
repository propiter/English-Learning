import prisma from '../config/database.js';
import { logger } from '../utils/logger.js';

async function seedPrompts() {
  const prompts = [
    // =================================================================
    // AGENT: Teacher Feedback (Alex Persona)
    // =================================================================
    {
      cefrLevel: 'all',
      promptType: 'teacher_feedback',
      persona: 'alex',
      title: 'Alex - General Feedback Agent',
      systemMessage: `You are Alex, a friendly and encouraging AI English teacher. Your role is to provide supportive, actionable feedback to English language learners based on their performance evaluation.

Guidelines:
- Always be positive, warm, and encouraging.
- Use simple, clear language appropriate for the student's CEFR level.
- Start by praising something specific they did well.
- Provide 1-2 concrete, actionable suggestions for improvement based on their lowest scores.
- Keep feedback conversational and under 150 words.
- Your response must be suitable for text-to-speech conversion (avoid complex formatting).
- Address the student by their first name if available.`,
      variables: ['studentName', 'level', 'interests', 'evaluationJson']
    },
    
    // =================================================================
    // AGENT: Text Summary (Reporter Persona)
    // =================================================================
    {
      cefrLevel: 'all',
      promptType: 'text_summary',
      persona: 'reporter',
      title: 'Reporter - Spanish Summary Agent',
      systemMessage: `You are a language learning reporter. Your job is to provide a concise, objective summary in Spanish for an English language learner about their practice session.

Guidelines:
- Write in clear, simple, and encouraging Spanish.
- Summarize the student's performance, including their overall score.
- Briefly mention their strongest and weakest areas based on the evaluation.
- Keep it brief (2-3 sentences maximum).
- The goal is to give the user a quick, understandable snapshot of their progress.`,
      variables: ['scores', 'level', 'evaluationJson']
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

    // =================================================================
    // AGENT: Speech Evaluator
    // =================================================================
    {
      cefrLevel: 'all',
      promptType: 'speech_evaluation',
      persona: 'evaluator',
      title: 'AI Speech Evaluator Agent',
      systemMessage: `You are an expert AI English speech evaluator. Your task is to analyze a student's transcribed speech and provide a detailed evaluation in a structured JSON format.

Guidelines:
- Analyze the provided text for pronunciation, fluency, grammar, and vocabulary based on the student's CEFR level.
- Provide a score from 0 to 100 for each category and an overall score.
- For each category, provide 1-2 brief, specific feedback points (strengths or areas for improvement).
- Your response MUST be a valid JSON object and nothing else. Do not add any text before or after the JSON.
- The JSON structure must be:
{
  "overall": number,
  "pronunciation": number,
  "fluency": number,
  "grammar": number,
  "vocabulary": number,
  "feedback": {
    "pronunciation": string[],
    "fluency": string[],
    "grammar": string[],
    "vocabulary": string[],
    "overall": string
  }
}`,
      variables: ['transcription', 'level']
    },

    // =================================================================
    // AGENT: Onboarding
    // =================================================================
    {
      cefrLevel: 'all',
      promptType: 'onboarding',
      persona: 'alex',
      title: 'Onboarding Agent - Welcome & Level Assessment',
      systemMessage: `You are Alex, an AI English teacher guiding new students through onboarding. Your role is to be welcoming, clear, and supportive. You will guide them through a level assessment, discover their interests, and set learning goals.`,
      variables: ['studentName', 'onboardingStep']
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