import prisma from '../../config/database.js';
import { User, CEFR_LEVELS } from '../../types/index.js';
import { createError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';

export const userService = {
  async createUser(userData: {
    telegramId?: string;
    whatsappId?: string;
    firstName: string;
    lastName?: string;
    username?: string;
    language?: string;
    timezone?: string;
  }) {
    try {
      // Check if user already exists
      const existingUser = await this.getUserByPlatformId(
        userData.telegramId ? 'telegram' : 'whatsapp',
        userData.telegramId || userData.whatsappId!
      );

      if (existingUser) {
        throw createError('User already exists', 409);
      }

      const user = await prisma.user.create({
        data: {
          ...userData,
          cefrLevel: 'A0', // Default level for new users
          isOnboarding: true,
          onboardingStep: 'welcome'
        },
        include: {
          subscription: true
        }
      });

      return user;
    } catch (error) {
      logger.error('Error creating user:', error);
      throw error;
    }
  },

  async getUserById(userId: string) {
    return await prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscription: true,
        sessions: {
          orderBy: { createdAt: 'desc' },
          take: 10
        },
        achievements: {
          include: {
            achievement: true
          }
        }
      }
    });
  },

  async getUserByPlatformId(platform: 'telegram' | 'whatsapp', platformId: string) {
    const whereClause = platform === 'telegram' 
      ? { telegramId: platformId }
      : { whatsappId: platformId };

    return await prisma.user.findUnique({
      where: whereClause,
      include: {
        subscription: true
      }
    });
  },

  async updateUser(userId: string, updateData: Partial<User>) {
    try {
      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          ...updateData,
          updatedAt: new Date()
        },
        include: {
          subscription: true
        }
      });

      return user;
    } catch (error) {
      logger.error('Error updating user:', error);
      throw createError('Failed to update user', 500);
    }
  },

  async getUserProgress(userId: string) {
    const user = await this.getUserById(userId);
    if (!user) {
      throw createError('User not found', 404);
    }

    // Get recent sessions for statistics
    const recentSessions = await prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 30
    });

    // Calculate statistics
    const totalSessions = recentSessions.length;
    const averageScore = totalSessions > 0 
      ? recentSessions.reduce((sum, session) => sum + session.overallScore, 0) / totalSessions
      : 0;

    const currentLevel = CEFR_LEVELS.find(level => level.code === user.cefrLevel);
    const nextLevel = CEFR_LEVELS.find(level => level.minScore > (currentLevel?.maxScore || 0));

    // Calculate progress to next level
    const progressToNextLevel = nextLevel 
      ? Math.min(100, (averageScore - (currentLevel?.minScore || 0)) / ((nextLevel.minScore - (currentLevel?.minScore || 0)) / 100))
      : 100;

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        cefrLevel: user.cefrLevel,
        xp: user.xp,
        streak: user.streak,
        lastActivity: user.lastActivity
      },
      stats: {
        totalSessions,
        averageScore: Math.round(averageScore),
        currentLevel,
        nextLevel,
        progressToNextLevel: Math.round(progressToNextLevel),
        recentSessions: recentSessions.slice(0, 10)
      }
    };
  },

  async updateUserProgress(userId: string, xpGained: number, sessionCompleted: boolean = true) {
    const user = await this.getUserById(userId);
    if (!user) {
      throw createError('User not found', 404);
    }

    const now = new Date();
    const lastActivity = new Date(user.lastActivity);
    const daysDiff = Math.floor((now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));

    let newStreak = user.streak;
    
    if (sessionCompleted) {
      // Update streak logic
      if (daysDiff === 1) {
        newStreak += 1; // Continue streak
      } else if (daysDiff === 0) {
        // Same day, keep current streak
        newStreak = user.streak;
      } else {
        newStreak = 1; // Reset streak
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        xp: user.xp + xpGained,
        streak: newStreak,
        lastActivity: now
      }
    });

    return {
      user: updatedUser,
      xpGained,
      streakChanged: newStreak !== user.streak,
      newStreak
    };
  },

  async checkLevelUpEligibility(userId: string) {
    // Get user's recent sessions to determine if they're ready for level up
    const recentSessions = await prisma.session.findMany({
      where: { 
        userId,
        sessionType: 'daily_practice',
        createdAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 20 // Last 20 sessions
    });

    if (recentSessions.length < 10) {
      return { eligible: false, reason: 'Need more practice sessions' };
    }

    const averageScore = recentSessions.reduce((sum, session) => sum + session.overallScore, 0) / recentSessions.length;
    const consistentHighScore = recentSessions.slice(0, 5).every(session => session.overallScore >= 75);

    const eligible = averageScore >= 80 && consistentHighScore;

    return {
      eligible,
      averageScore: Math.round(averageScore),
      reason: eligible ? 'Ready for level up test' : 'Need higher consistent scores'
    };
  }
};