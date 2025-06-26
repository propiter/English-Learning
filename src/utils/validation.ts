import Joi from 'joi';

export const userRegistrationSchema = Joi.object({
  telegramId: Joi.string().optional(),
  whatsappId: Joi.string().optional(),
  firstName: Joi.string().required().min(1).max(50),
  lastName: Joi.string().optional().max(50),
  username: Joi.string().optional().max(50),
  language: Joi.string().optional().default('es'),
  timezone: Joi.string().optional().default('UTC')
}).or('telegramId', 'whatsappId');

export const sessionCreationSchema = Joi.object({
  userId: Joi.string().uuid().required(),
  userInput: Joi.string().required(),
  transcription: Joi.string().required(),
  inputType: Joi.string().valid('audio', 'text').default('audio'),
  evaluationJson: Joi.object().required(),
  overallScore: Joi.number().min(0).max(100).required(),
  pronunciation: Joi.number().min(0).max(100).optional(),
  fluency: Joi.number().min(0).max(100).optional(),
  grammar: Joi.number().min(0).max(100).optional(),
  vocabulary: Joi.number().min(0).max(100).optional(),
  duration: Joi.number().min(0).optional(),
  wordsSpoken: Joi.number().min(0).optional(),
  sessionType: Joi.string().valid('daily_practice', 'level_test', 'challenge').default('daily_practice')
});

export const userUpdateSchema = Joi.object({
  firstName: Joi.string().min(1).max(50).optional(),
  lastName: Joi.string().max(50).optional(),
  cefrLevel: Joi.string().valid('A0', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2').optional(),
  interests: Joi.array().items(Joi.string().max(30)).max(10).optional(),
  learningGoal: Joi.string().max(100).optional(),
  timezone: Joi.string().optional(),
  language: Joi.string().optional(),
  isOnboarding: Joi.boolean().optional(),
  onboardingStep: Joi.string().optional()
});

export const webhookSchema = Joi.object({
  platform: Joi.string().valid('telegram', 'whatsapp').required(),
  webhookData: Joi.object().required()
});