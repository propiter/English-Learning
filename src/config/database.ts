import { PrismaClient } from '@prisma/client';

declare global {
  var __prisma: PrismaClient | undefined;
}

const prisma = globalThis.__prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}

export default prisma;