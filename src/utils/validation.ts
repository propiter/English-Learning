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
  sessionType: Joi.string().valid('daily_practice', 'level_test', 'challenge').default('daily_practice'),
  feedbackAudioUrl: Joi.string().uri().optional(),
  feedbackText: Joi.string().optional()
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
  webhookData: Joi.object().required(),
  signature: Joi.string().optional()
});

// Webhook validation schemas
export const telegramWebhookSchema = Joi.object({
  update_id: Joi.number().required(),
  message: Joi.object({
    message_id: Joi.number().required(),
    from: Joi.object({
      id: Joi.number().required(),
      is_bot: Joi.boolean().required(),
      first_name: Joi.string().required(),
      last_name: Joi.string().optional(),
      username: Joi.string().optional(),
      language_code: Joi.string().optional()
    }).required(),
    chat: Joi.object({
      id: Joi.number().required(),
      type: Joi.string().required()
    }).required(),
    date: Joi.number().required(),
    text: Joi.string().optional(),
    voice: Joi.object({
      duration: Joi.number().required(),
      mime_type: Joi.string().required(),
      file_id: Joi.string().required(),
      file_unique_id: Joi.string().required(),
      file_size: Joi.number().optional()
    }).optional()
  }).optional()
});

export const whatsappWebhookSchema = Joi.object({
  object: Joi.string().valid('whatsapp_business_account').required(),
  entry: Joi.array().items(
    Joi.object({
      id: Joi.string().required(),
      changes: Joi.array().items(
        Joi.object({
          value: Joi.object({
            messaging_product: Joi.string().valid('whatsapp').required(),
            metadata: Joi.object().required(),
            contacts: Joi.array().optional(),
            messages: Joi.array().items(
              Joi.object({
                from: Joi.string().required(),
                id: Joi.string().required(),
                timestamp: Joi.string().required(),
                type: Joi.string().valid('text', 'audio', 'image', 'video', 'document').required(),
                text: Joi.object({
                  body: Joi.string().required()
                }).optional(),
                audio: Joi.object({
                  id: Joi.string().required(),
                  mime_type: Joi.string().optional()
                }).optional()
              })
            ).optional()
          }).required(),
          field: Joi.string().valid('messages').required()
        })
      ).required()
    })
  ).required()
});