import { z } from 'zod';

/**
 * User registration validation schema
 */
export const userRegistrationSchema = z.object({
  telegramId: z.string().optional(),
  whatsappId: z.string().optional(),
  firstName: z.string().min(1, 'First name is required').max(50, 'First name too long'),
  lastName: z.string().max(50, 'Last name too long').optional(),
  username: z.string().max(50, 'Username too long').optional(),
  language: z.string().length(2, 'Language must be 2 characters').default('es'),
  timezone: z.string().default('UTC')
}).refine(data => data.telegramId || data.whatsappId, {
  message: 'Either telegramId or whatsappId must be provided'
});

/**
 * Session creation validation schema
 */
export const sessionCreationSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
  userInput: z.string().min(1, 'User input is required'),
  transcription: z.string().min(1, 'Transcription is required'),
  inputType: z.enum(['audio', 'text']).default('audio'),
  evaluationJson: z.record(z.any()),
  overallScore: z.number().min(0).max(100),
  pronunciation: z.number().min(0).max(100).optional(),
  fluency: z.number().min(0).max(100).optional(),
  grammar: z.number().min(0).max(100).optional(),
  vocabulary: z.number().min(0).max(100).optional(),
  duration: z.number().min(0).optional(),
  wordsSpoken: z.number().min(0).optional(),
  sessionType: z.enum(['daily_practice', 'level_test', 'challenge']).default('daily_practice'),
  feedbackAudioUrl: z.string().url().optional(),
  feedbackText: z.string().optional()
});

/**
 * User update validation schema
 */
export const userUpdateSchema = z.object({
  firstName: z.string().min(1).max(50).optional(),
  lastName: z.string().max(50).optional(),
  cefrLevel: z.enum(['A0', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']).optional(),
  interests: z.array(z.string().max(30)).max(10).optional(),
  learningGoal: z.string().max(100).optional(),
  timezone: z.string().optional(),
  language: z.string().length(2).optional(),
  isOnboarding: z.boolean().optional(),
  onboardingStep: z.string().optional()
});

/**
 * Telegram webhook validation schema
 */
export const telegramWebhookSchema = z.object({
  update_id: z.number(),
  message: z.object({
    message_id: z.number(),
    from: z.object({
      id: z.number(),
      is_bot: z.boolean(),
      first_name: z.string(),
      last_name: z.string().optional(),
      username: z.string().optional(),
      language_code: z.string().optional()
    }),
    chat: z.object({
      id: z.number(),
      type: z.string()
    }),
    date: z.number(),
    text: z.string().optional(),
    voice: z.object({
      duration: z.number(),
      mime_type: z.string(),
      file_id: z.string(),
      file_unique_id: z.string(),
      file_size: z.number().optional()
    }).optional()
  }).optional()
});

/**
 * WhatsApp webhook validation schema
 */
export const whatsappWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: z.object({
            messaging_product: z.literal('whatsapp'),
            metadata: z.record(z.any()),
            contacts: z.array(z.record(z.any())).optional(),
            messages: z.array(
              z.object({
                from: z.string(),
                id: z.string(),
                timestamp: z.string(),
                type: z.enum(['text', 'audio', 'image', 'video', 'document']),
                text: z.object({
                  body: z.string()
                }).optional(),
                audio: z.object({
                  id: z.string(),
                  mime_type: z.string().optional()
                }).optional()
              })
            ).optional()
          }),
          field: z.literal('messages')
        })
      )
    })
  )
});

/**
 * Onboarding step validation schema
 */
export const onboardingStepSchema = z.object({
  userId: z.string().uuid(),
  input: z.string().min(1),
  currentStep: z.enum(['welcome', 'level_test', 'interests', 'goal']),
  platform: z.enum(['telegram', 'whatsapp'])
});

/**
 * Audio file validation
 */
export const audioFileSchema = z.object({
  fileId: z.string().min(1),
  mimeType: z.string().regex(/^audio\/(mp3|wav|ogg|m4a|mpeg|x-wav)$/),
  fileSize: z.number().max(10 * 1024 * 1024), // 10MB max
  duration: z.number().min(1).max(300) // 1 second to 5 minutes
});

/**
 * Validate request body with schema
 */
export const validateRequestBody = <T>(schema: z.ZodSchema<T>) => {
  return (data: unknown): T => {
    try {
      return schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);
        throw new Error(`Validation failed: ${errorMessages.join(', ')}`);
      }
      throw error;
    }
  };
};

/**
 * Sanitize user input to prevent XSS and injection attacks
 */
export const sanitizeInput = (input: string): string => {
  return input
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers
    .trim();
};