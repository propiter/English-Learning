import prisma from '../../config/database.js';
import { Session, CEFR_LEVELS } from '../../types/index.js';
import { createError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';

export const learningService = {
  async createSession(sessionData: {
    userId: string;
    userInput: string;
    transcription: string;
    inputType: string;
    evaluationJson: any;
    overallScore: number;
    pronunciation?: number;
    fluency?: number;
    grammar?: number;
    vocabulary?: number;
    duration?: number;
    wordsSpoken?: number;
    sessionType: string;
    feedbackAudioUrl?: string;
    feedbackText?: string;
  }) {
    try {
      // Calculate XP for this session
      const user = await prisma.user.findUnique({ where: { id: sessionData.userId } });
      if (!user) {
        throw createError('User not found', 404);
      }

      const xpEarned = this.calculateXP(
        sessionData.overallScore,
        sessionData.duration,
        sessionData.sessionType,
        user.cefrLevel
      );

      const session = await prisma.session.create({
        data: {
          ...sessionData,
          xpEarned,
          wordsSpoken: sessionData.wordsSpoken || this.countWords(sessionData.transcription)
        }
      });

      // Update user progress in background (with proper error handling)
      this.updateUserProgressAsync(sessionData.userId, xpEarned)
        .catch(error => {
          logger.error('Background user progress update failed:', error);
        });

      return session;
    } catch (error) {
      logger.error('Error creating session:', error);
      throw error;
    }
  },

  async getSessionById(sessionId: string) {
    try {
      return await prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              cefrLevel: true
            }
          }
        }
      });
    } catch (error) {
      logger.error('Error fetching session:', error);
      throw error;
    }
  },

  async getUserProgress(userId: string, timeframeDays: number = 30) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - timeframeDays);

      const sessions = await prisma.session.findMany({
        where: {
          userId,
          createdAt: {
            gte: startDate
          }
        },
        orderBy: { createdAt: 'desc' }
      });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          cefrLevel: true,
          xp: true,
          streak: true,
          lastActivity: true
        }
      });

      if (!user) {
        throw createError('User not found', 404);
      }

      // Calculate statistics
      const totalSessions = sessions.length;
      const averageScore = totalSessions > 0 
        ? sessions.reduce((sum, session) => sum + session.overallScore, 0) / totalSessions
        : 0;

      const averageScores = {
        overall: averageScore,
        pronunciation: this.calculateAverageScore(sessions, 'pronunciation'),
        fluency: this.calculateAverageScore(sessions, 'fluency'),
        grammar: this.calculateAverageScore(sessions, 'grammar'),
        vocabulary: this.calculateAverageScore(sessions, 'vocabulary')
      };

      // Weekly progress
      const weeklyProgress = this.calculateWeeklyProgress(sessions);

      // Strengths and weaknesses
      const analysis = this.analyzePerformance(sessions);

      return {
        timeframe: timeframeDays,
        totalSessions,
        averageScores,
        weeklyProgress,
        analysis,
        user: {
          cefrLevel: user.cefrLevel,
          xp: user.xp,
          streak: user.streak,
          lastActivity: user.lastActivity
        }
      };
    } catch (error) {
      logger.error('Error getting user progress:', error);
      throw error;
    }
  },

  async getSessionHistory(userId: string, page: number = 1, limit: number = 20) {
    try {
      const skip = (page - 1) * limit;

      const [sessions, total] = await Promise.all([
        prisma.session.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            transcription: true,
            overallScore: true,
            pronunciation: true,
            fluency: true,
            grammar: true,
            vocabulary: true,
            xpEarned: true,
            duration: true,
            sessionType: true,
            createdAt: true
          }
        }),
        prisma.session.count({ where: { userId } })
      ]);

      return {
        sessions,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      logger.error('Error getting session history:', error);
      throw error;
    }
  },

  calculateXP(score: number, duration: number = 0, sessionType: string, userLevel: string): number {
    let baseXP = 10;

    // Score multiplier (0.5x to 2x based on score)
    const scoreMultiplier = Math.max(0.5, Math.min(2, score / 50));

    // Session type multiplier
    const typeMultipliers: { [key: string]: number } = {
      'daily_practice': 1,
      'level_test': 2,
      'challenge': 1.5
    };

    // Duration bonus (extra XP for longer sessions)
    const durationBonus = duration > 60 ? Math.floor(duration / 60) * 2 : 0;

    // Level multiplier (higher levels get more XP)
    const levelMultipliers: { [key: string]: number } = {
      'A0': 1, 'A1': 1.1, 'A2': 1.2, 'B1': 1.3, 'B2': 1.4, 'C1': 1.5, 'C2': 1.6
    };

    const finalXP = Math.round(
      baseXP * 
      scoreMultiplier * 
      (typeMultipliers[sessionType] || 1) * 
      (levelMultipliers[userLevel] || 1) + 
      durationBonus
    );

    return Math.max(1, finalXP); // Minimum 1 XP
  },

  async checkLevelUpEligibility(userId: string) {
    try {
      const recentSessions = await prisma.session.findMany({
        where: {
          userId,
          sessionType: 'daily_practice',
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 15
      });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { cefrLevel: true }
      });

      if (!user || recentSessions.length < 8) {
        return {
          eligible: false,
          reason: 'Need at least 8 practice sessions in the last 30 days',
          sessionsNeeded: Math.max(0, 8 - recentSessions.length)
        };
      }

      const averageScore = recentSessions.reduce((sum, session) => sum + session.overallScore, 0) / recentSessions.length;
      const consistentHighScore = recentSessions.slice(0, 5).every(session => session.overallScore >= 70);

      const currentLevel = CEFR_LEVELS.find(level => level.code === user.cefrLevel);
      const nextLevel = CEFR_LEVELS.find(level => level.minScore > (currentLevel?.maxScore || 0));

      if (!nextLevel) {
        return {
          eligible: false,
          reason: 'Already at maximum level',
          currentLevel: user.cefrLevel
        };
      }

      const requiredScore = nextLevel.minScore - 5; // 5 points buffer
      const eligible = averageScore >= requiredScore && consistentHighScore;

      return {
        eligible,
        currentLevel: user.cefrLevel,
        nextLevel: nextLevel.code,
        averageScore: Math.round(averageScore),
        requiredScore,
        reason: eligible 
          ? 'Ready for level-up test!' 
          : `Need average score of ${requiredScore}+ with consistent performance`
      };
    } catch (error) {
      logger.error('Error checking level up eligibility:', error);
      throw error;
    }
  },

  async getLearningAnalytics(userId: string, startDate?: Date, endDate?: Date) {
    try {
      const dateFilter: any = { userId };
      
      if (startDate || endDate) {
        dateFilter.createdAt = {};
        if (startDate) dateFilter.createdAt.gte = startDate;
        if (endDate) dateFilter.createdAt.lte = endDate;
      }

      const sessions = await prisma.session.findMany({
        where: dateFilter,
        orderBy: { createdAt: 'asc' }
      });

      if (sessions.length === 0) {
        return {
          totalSessions: 0,
          timeSpent: 0,
          averageScore: 0,
          improvementRate: 0,
          skillBreakdown: {},
          weeklyTrends: [],
          achievements: []
        };
      }

      // Time spent (in minutes)
      const timeSpent = sessions.reduce((sum, session) => sum + (session.duration || 0), 0) / 60;

      // Improvement rate (comparing first vs last 25% of sessions)
      const improvementRate = this.calculateImprovementRate(sessions);

      // Skill breakdown
      const skillBreakdown = {
        pronunciation: this.calculateAverageScore(sessions, 'pronunciation'),
        fluency: this.calculateAverageScore(sessions, 'fluency'),
        grammar: this.calculateAverageScore(sessions, 'grammar'),
        vocabulary: this.calculateAverageScore(sessions, 'vocabulary')
      };

      // Weekly trends
      const weeklyTrends = this.calculateWeeklyTrends(sessions);

      // Mock achievements (in production, this would come from a separate achievements system)
      const achievements = await this.getUserAchievements(userId);

      return {
        totalSessions: sessions.length,
        timeSpent: Math.round(timeSpent),
        averageScore: Math.round(sessions.reduce((sum, s) => sum + s.overallScore, 0) / sessions.length),
        improvementRate,
        skillBreakdown,
        weeklyTrends,
        achievements
      };
    } catch (error) {
      logger.error('Error getting learning analytics:', error);
      throw error;
    }
  },

  // Helper methods
  countWords(text: string): number {
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  },

  calculateAverageScore(sessions: any[], field: string): number {
    const scores = sessions.map(s => s[field]).filter(score => score !== null && score !== undefined);
    return scores.length > 0 ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  },

  calculateWeeklyProgress(sessions: any[]) {
    const weeklyData: { [key: string]: { sessions: number; avgScore: number; totalXP: number } } = {};

    sessions.forEach(session => {
      const weekStart = new Date(session.createdAt);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Start of week
      const weekKey = weekStart.toISOString().split('T')[0];

      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = { sessions: 0, avgScore: 0, totalXP: 0 };
      }

      weeklyData[weekKey].sessions++;
      weeklyData[weekKey].avgScore += session.overallScore;
      weeklyData[weekKey].totalXP += session.xpEarned;
    });

    // Calculate averages
    Object.keys(weeklyData).forEach(week => {
      weeklyData[week].avgScore = Math.round(weeklyData[week].avgScore / weeklyData[week].sessions);
    });

    return Object.entries(weeklyData)
      .map(([week, data]) => ({ week, ...data }))
      .sort((a, b) => a.week.localeCompare(b.week));
  },

  analyzePerformance(sessions: any[]) {
    const skills = ['pronunciation', 'fluency', 'grammar', 'vocabulary'];
    const averages = skills.map(skill => ({
      skill,
      average: this.calculateAverageScore(sessions, skill)
    }));

    const strengths = averages.filter(s => s.average >= 75).map(s => s.skill);
    const weaknesses = averages.filter(s => s.average < 60).map(s => s.skill);

    return {
      strengths,
      weaknesses,
      averages: averages.reduce((acc, { skill, average }) => ({ ...acc, [skill]: average }), {})
    };
  },

  calculateImprovementRate(sessions: any[]): number {
    if (sessions.length < 4) return 0;

    const quarter = Math.floor(sessions.length / 4);
    const firstQuarter = sessions.slice(0, quarter);
    const lastQuarter = sessions.slice(-quarter);

    const firstAvg = firstQuarter.reduce((sum, s) => sum + s.overallScore, 0) / firstQuarter.length;
    const lastAvg = lastQuarter.reduce((sum, s) => sum + s.overallScore, 0) / lastQuarter.length;

    return Math.round(((lastAvg - firstAvg) / firstAvg) * 100);
  },

  calculateWeeklyTrends(sessions: any[]) {
    const weeklyData: { [key: string]: number[] } = {};

    sessions.forEach(session => {
      const week = new Date(session.createdAt).toISOString().split('T')[0];
      if (!weeklyData[week]) weeklyData[week] = [];
      weeklyData[week].push(session.overallScore);
    });

    return Object.entries(weeklyData)
      .map(([week, scores]) => ({
        week,
        averageScore: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
        sessionsCount: scores.length
      }))
      .sort((a, b) => a.week.localeCompare(b.week));
  },

  async getUserAchievements(userId: string) {
    try {
      const achievements = await prisma.userAchievement.findMany({
        where: { userId },
        include: {
          achievement: true
        },
        orderBy: { unlockedAt: 'desc' }
      });

      return achievements.map(ua => ({
        id: ua.achievement.id,
        code: ua.achievement.code,
        title: ua.achievement.title,
        description: ua.achievement.description,
        icon: ua.achievement.icon,
        unlockedAt: ua.unlockedAt
      }));
    } catch (error) {
      logger.error('Error getting user achievements:', error);
      return [];
    }
  },

  async updateUserProgressAsync(userId: string, xpEarned: number) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        logger.warn(`User not found for progress update: ${userId}`);
        return;
      }

      const now = new Date();
      const lastActivity = new Date(user.lastActivity);
      const daysDiff = Math.floor((now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));

      let newStreak = user.streak;
      if (daysDiff === 1) {
        newStreak += 1;
      } else if (daysDiff > 1) {
        newStreak = 1;
      }

      await prisma.user.update({
        where: { id: userId },
        data: {
          xp: user.xp + xpEarned,
          streak: newStreak,
          lastActivity: now
        }
      });

      logger.info(`User progress updated: ${userId}, XP: +${xpEarned}, Streak: ${newStreak}`);
    } catch (error) {
      logger.error('Error updating user progress:', error);
      // Don't throw - this is a background operation
    }
  }
};