-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT,
    "whatsappId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "username" TEXT,
    "cefrLevel" TEXT NOT NULL DEFAULT 'A0',
    "xp" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "interests" TEXT[],
    "learningGoal" TEXT,
    "onboardingStep" TEXT NOT NULL DEFAULT 'welcome',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionType" TEXT NOT NULL DEFAULT 'practice',
    "userInput" TEXT NOT NULL,
    "transcription" TEXT NOT NULL,
    "evaluationJson" JSONB NOT NULL,
    "feedbackAudioUrl" TEXT,
    "feedbackText" TEXT,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "pronunciation" DOUBLE PRECISION,
    "fluency" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "completeness" DOUBLE PRECISION,
    "xpEarned" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" TEXT NOT NULL,
    "cefrLevel" TEXT NOT NULL,
    "promptType" TEXT NOT NULL,
    "category" TEXT,
    "systemMessage" TEXT NOT NULL,
    "userPrompt" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievements" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT,
    "xpReward" INTEGER NOT NULL DEFAULT 0,
    "badgeColor" TEXT NOT NULL DEFAULT '#gold',
    "requirement" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_achievements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "service" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "tokensUsed" INTEGER,
    "cost" DOUBLE PRECISION,
    "responseTime" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "users_whatsappId_key" ON "users"("whatsappId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "achievements_name_key" ON "achievements"("name");

-- CreateIndex
CREATE UNIQUE INDEX "user_achievements_userId_achievementId_key" ON "user_achievements"("userId", "achievementId");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
