import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';

// Import configuration
import env from './config/environment.js';
import redisManager from './config/redis.js';

// Import middleware
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter, speedLimiter } from './middleware/rateLimiter.js';
import { securityHeaders, requestId, validateContentType, sanitizeBody } from './middleware/security.js';
import { logger, logRequest } from './utils/logger.js';

// Import routes
import userRoutes from './modules/users/routes.js';
import learningRoutes from './modules/learning/routes.js';
import orchestratorRoutes from './modules/orchestrator/routes.js';
import contentRoutes from './modules/content/routes.js';
import gatewayRoutes from './modules/gateway/routes.js';
import onboardingRoutes from './modules/onboarding/routes.js';

const app = express();

/**
 * Trust proxy for accurate IP addresses behind load balancers
 */
app.set('trust proxy', 1);

/**
 * Security middleware
 */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(securityHeaders);
app.use(requestId);

/**
 * CORS configuration
 */
const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      logger.warn('CORS blocked request', { origin, allowedOrigins });
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID']
}));

/**
 * Rate limiting
 */
app.use('/', apiLimiter);
app.use('/', speedLimiter);

/**
 * Body parsing middleware
 */
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    // Store raw body for webhook signature verification
    (req as any).rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/**
 * Content validation and sanitization
 */
app.use(validateContentType);
app.use(sanitizeBody);

/**
 * Compression middleware
 */
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  },
  level: 6,
  threshold: 1024
}));

/**
 * Logging middleware
 */
app.use(morgan('combined', {
  stream: { 
    write: (message) => {
      // Parse morgan log and extract useful information
      const logData = message.trim();
      logger.info('HTTP Request', { raw: logData });
    }
  },
  skip: (req, res) => {
    // Skip logging for health checks in production
    return process.env.NODE_ENV === 'production' && req.url === '/health';
  }
}));

/**
 * Request timing middleware
 */
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    logRequest(req, res, responseTime);
  });
  
  next();
});

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
  const healthCheck = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    version: process.env.npm_package_version || '1.0.0',
    requestId: req.id,
    services: {
      database: 'unknown',
      redis: redisManager.isReady() ? 'healthy' : 'unhealthy'
    }
  };

  // Check database connection
  try {
    const { default: prisma } = await import('./config/database.js');
    await prisma.$queryRaw`SELECT 1`;
    healthCheck.services.database = 'healthy';
  } catch (error) {
    healthCheck.services.database = 'unhealthy';
    healthCheck.status = 'degraded';
  }

  const statusCode = healthCheck.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(healthCheck);
});

/**
 * API routes
 */
app.use('/users', userRoutes);
app.use('/learning', learningRoutes);
app.use('/orchestrator', orchestratorRoutes);
app.use('/content', contentRoutes);
app.use('/gateway', gatewayRoutes);
app.use('/onboarding', onboardingRoutes);

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.json({
    message: 'English Learning SaaS API',
    version: process.env.npm_package_version || '1.0.0',
    environment: env.NODE_ENV,
    documentation: '/docs',
    health: '/health',
    requestId: req.id,
    timestamp: new Date().toISOString()
  });
});

/**
 * API documentation endpoint
 */
app.get('/docs', (req, res) => {
  res.json({
    title: 'English Learning SaaS API Documentation',
    version: '1.0.0',
    endpoints: {
      users: {
        'POST /users/register': 'Register new user',
        'GET /users/:id': 'Get user profile',
        'PUT /users/:id': 'Update user profile',
        'GET /users/:id/progress': 'Get user progress'
      },
      learning: {
        'POST /learning/sessions': 'Create learning session',
        'GET /learning/users/:userId/sessions': 'Get session history',
        'GET /learning/users/:userId/analytics': 'Get learning analytics'
      },
      gateway: {
        'POST /gateway/webhook/telegram': 'Telegram webhook',
        'POST /gateway/webhook/whatsapp': 'WhatsApp webhook'
      },
      content: {
        'GET /content/prompts': 'Get AI prompts',
        'GET /content/daily-topic': 'Get daily practice topic'
      }
    },
    requestId: req.id
  });
});

/**
 * 404 handler
 */
app.use('*', notFoundHandler);

/**
 * Global error handler (must be last)
 */
app.use(errorHandler);

/**
 * Graceful shutdown handlers
 */
const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  // Close server
  server.close(async () => {
    logger.info('HTTP server closed');
    
    try {
      // Close database connections
      const { default: prisma } = await import('./config/database.js');
      await prisma.$disconnect();
      logger.info('Database disconnected');
      
      // Close Redis connection
      await redisManager.disconnect();
      logger.info('Redis disconnected');
      
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * Initialize services and start server
 */
async function startServer() {
  try {
    // Connect to Redis
    await redisManager.connect();
    
    // Start server
    const server = app.listen(env.PORT, () => {
      logger.info('🚀 Server started successfully', {
        port: env.PORT,
        environment: env.NODE_ENV,
        nodeVersion: process.version,
        pid: process.pid
      });
      
      if (env.NODE_ENV === 'development') {
        logger.info('📊 Development URLs:', {
          api: `http://localhost:${env.PORT}`,
          health: `http://localhost:${env.PORT}/health`,
          docs: `http://localhost:${env.PORT}/api/docs`
        });
      }
    });

    // Set server timeout
    server.timeout = 30000; // 30 seconds
    server.keepAliveTimeout = 65000; // 65 seconds
    server.headersTimeout = 66000; // 66 seconds

    return server;
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
const server = await startServer();

export default app;