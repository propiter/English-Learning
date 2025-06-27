export type Platform = 'telegram' | 'whatsapp';
export type InputType = 'text' | 'audio';

export interface User {
  id: string;
  telegramId?: string;
  whatsappId?: string;
  firstName: string;
  lastName?: string;
  username?: string;
  cefrLevel: string;
  xp: number;
  streak: number;
  lastActivity: Date;
  interests: string[];
  learningGoal?: string;
  isOnboarding: boolean;
  onboardingStep: string;
  timezone: string;
  language: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  userId: string;
  userInput: string;
  transcription: string | null;
  inputType: InputType;
  evaluationJson: any;
  overallScore: number;
  pronunciation?: number;
  fluency?: number;
  grammar?: number;
  vocabulary?: number;
  feedbackAudioUrl?: string;
  feedbackText?: string;
  duration?: number;
  wordsSpoken?: number;
  xpEarned: number;
  sessionType: string;
  createdAt: Date;
}

export interface LevelTest {
  id: string;
  userId: string;
  testType: string;
  fromLevel?: string;
  resultLevel: string;
  questions: any[];
  responses: any[];
  overallScore: number;
  completed: boolean;
  createdAt: Date;
  completedAt?: Date;
}

export interface EvaluationResponse {
  overall: number;
  pronunciation: number;
  fluency: number;
  grammar: number;
  vocabulary: number;
  feedback: {
    pronunciation: string[];
    grammar: string[];
    vocabulary: string[];
    fluency: string[];
    overall: string;
  };
}

export interface MessagePayload {
  platformId: string; // The ID from the specific platform (e.g., Telegram chat ID, WhatsApp phone number)
  platform: Platform;
  inputType: InputType;
  content: string; // Text content or audio file ID/path
  chatId?: string; // Redundant but can be useful
  rawData?: any;
  userData?: {
    firstName?: string;
    lastName?: string;
    username?: string;
  };
}

export interface FeedbackResponse {
  audioUrl?: string;
  textSummary: string;
  xpEarned: number;
  levelUp?: boolean;
  newLevel?: string;
}

export interface OnboardingState {
  step: string;
  data: {
    testQuestions?: any[];
    currentQuestion?: number;
    responses?: any[];
    tempLevel?: string;
  };
}

export interface CEFRLevel {
  code: string;
  name: string;
  description: string;
  minScore: number;
  maxScore: number;
}

export const CEFR_LEVELS: CEFRLevel[] = [
  { code: 'A0', name: 'Beginner', description: 'Complete beginner', minScore: 0, maxScore: 20 },
  { code: 'A1', name: 'Elementary', description: 'Basic words and phrases', minScore: 21, maxScore: 35 },
  { code: 'A2', name: 'Pre-intermediate', description: 'Simple conversations', minScore: 36, maxScore: 50 },
  { code: 'B1', name: 'Intermediate', description: 'Independent user', minScore: 51, maxScore: 65 },
  { code: 'B2', name: 'Upper-intermediate', description: 'Complex topics', minScore: 66, maxScore: 80 },
  { code: 'C1', name: 'Advanced', description: 'Proficient user', minScore: 81, maxScore: 92 },
  { code: 'C2', name: 'Mastery', description: 'Near-native fluency', minScore: 93, maxScore: 100 }
];
