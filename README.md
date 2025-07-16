# English Learning SaaS Backend - Production Ready

A comprehensive, production-ready backend system for an English conversational learning platform that integrates with Telegram and WhatsApp, providing AI-powered feedback and personalized learning experiences.

## 🏗️ Architecture Overview

The system is built with a modular, microservices-inspired architecture consisting of 6 main modules:

### 1. **User & Auth Core** (`/src/modules/users`)
- User registration and profile management
- Authentication and authorization
- Progress tracking and XP system
- Streak management

### 2. **Learning & Progress Engine** (`/src/modules/learning`)
- Session management and storage
- Progress analytics and statistics
- XP calculation and level progression
- Learning performance analysis

### 3. **AI Agent Orchestrator** (`/src/modules/orchestrator`)
- Main business logic coordinator
- Speech-to-text processing
- AI feedback generation (audio + text)
- External API integrations with retry logic

### 4. **Content & Prompts Manager** (`/src/modules/content`)
- Dynamic prompt management
- Level-appropriate content delivery
- Daily practice topic generation
- Multi-persona AI responses

### 5. **Messaging Gateway** (`/src/modules/gateway`)
- Telegram and WhatsApp webhook handling
- Message routing and delivery
- Platform-specific message formatting
- Webhook logging and debugging

### 6. **Onboarding & Evaluation Engine** (`/src/modules/onboarding`)
- New user onboarding flow with state management
- Initial level assessment
- Interest and goal collection
- Level-up test management

## 🚀 Key Features

- **Multi-Platform Support**: Telegram and WhatsApp integration
- **AI-Powered Feedback**: OpenAI GPT-4 and TTS integration
- **CEFR Level System**: A0-C2 level progression
- **Gamification**: XP, streaks, and achievements
- **Personalization**: Interest-based content and learning goals
- **Real-time Processing**: Async message handling with proper error recovery
- **Comprehensive Analytics**: Learning progress and performance tracking
- **Production-Ready**: Full error handling, logging, monitoring, and security
- **Scalable Architecture**: Modular design with internal APIs

## 🛠️ Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Framework**: Express.js with comprehensive middleware
- **Database**: PostgreSQL with Prisma ORM
- **Cache**: Redis with connection management
- **AI Services**: OpenAI GPT-4 and Whisper
- **Authentication**: JWT with secure secret management
- **Validation**: Zod for runtime type checking
- **Logging**: Winston with structured logging
- **Containerization**: Docker with multi-stage builds
- **Security**: Helmet, rate limiting, input sanitization
- **Monitoring**: Health checks and metrics

## 📦 Installation

### Prerequisites
- Node.js 18+
- PostgreSQL 15+
- Redis 7+
- Docker & Docker Compose (recommended)

### Quick Start with Docker

1. **Clone and setup environment**:
```bash
git clone <repository-url>
cd english-learning-backend
cp .env.example .env
# Edit .env with your configuration
```

2. **Start with Docker Compose**:
```bash
docker-compose up -d
```

This will start:
- API server on port 3000
- PostgreSQL on port 5432
- Redis on port 6379
- Nginx reverse proxy on ports 80/443

### Local Development Setup

1. **Install dependencies**:
```bash
npm install
```

2. **Environment setup**:
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Database setup**:
```bash
# Generate Prisma client
npm run db:generate

# Run migrations
npm run db:migrate

# Seed initial data
npm run db:seed
```

4. **Start development server**:
```bash
npm run dev
```

## 🔧 Configuration

### Required Environment Variables

All configuration is managed through environment variables. See `.env.example` for the complete list.

**Critical Variables:**
```env
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/english_learning_db"

# Security (minimum 32 characters each)
JWT_SECRET="your-super-secret-jwt-key-minimum-32-characters-long"
INTERNAL_API_KEY="your-internal-api-key-for-module-communication-32-chars"

# OpenAI
OPENAI_API_KEY="sk-your-openai-api-key-here"

# Messaging Platforms
TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
WHATSAPP_ACCESS_TOKEN="your-whatsapp-access-token"
```

### Security Configuration

- **Rate Limiting**: Configurable per endpoint type
- **CORS**: Whitelist-based origin control
- **Input Validation**: Zod schemas for all inputs
- **Webhook Verification**: Signature validation for all webhooks
- **Error Handling**: Comprehensive error catching and user-friendly responses

## 📡 API Endpoints

### User Management
- `POST /users/register` - Register new user
- `GET /users/:id` - Get user profile
- `PUT /users/:id` - Update user profile
- `GET /users/:id/progress` - Get learning progress

### Learning Sessions
- `POST /learning/sessions` - Create learning session (internal)
- `GET /learning/users/:userId/sessions` - Get session history
- `GET /learning/users/:userId/analytics` - Get learning analytics

### Content Management
- `GET /content/prompts` - Get AI prompts (internal)
- `GET /content/daily-topic` - Get daily practice topic

### Messaging
- `POST /gateway/webhook/telegram` - Telegram webhook
- `POST /gateway/webhook/whatsapp` - WhatsApp webhook
## Webchat
- `GET /gateway/webchat/:chatId/messages` - Get webchat messages
- `POST /gateway/webchat/:chatId/send` - Send webchat message

### Orchestrator
- `POST /orchestrator/process-message` - Process user message (internal)

### Health & Monitoring
- `GET /health` - Health check with service status
- `GET /orchestrator/llm-status` - LLM providers status
- `GET /orchestrator/stt-status` - Speech-to-Text providers status
- `GET /orchestrator/tts-status` - Text-to-Speech providers status
- `GET /docs` - API documentation

## 🔄 Main User Flow

1. **User sends voice message** → Messaging Gateway receives webhook
2. **Gateway processes** → Validates, extracts user data, forwards to Orchestrator
3. **Orchestrator coordinates**:
   - Gets/creates user profile
   - Handles onboarding if needed
   - Transcribes audio (OpenAI Whisper)
   - Evaluates speech (external API with retry)
   - Generates AI feedback (GPT-4 + TTS)
   - Saves session data (with transaction)
   - Updates user progress
4. **Response delivery** → Audio feedback + text summary sent back

## 🧪 Testing

```bash
# Run tests
npm test

# Run with coverage
npm run test:coverage

# Lint code
npm run lint
```

## 📊 Database Schema

The system uses PostgreSQL with the following main entities:

- **Users**: Profile, level, XP, streak, preferences
- **Sessions**: Practice sessions with evaluations and feedback
- **LevelTests**: Initial and progression assessments
- **Prompts**: AI system prompts for different levels/personas
- **Achievements**: Gamification rewards
- **Subscriptions**: Payment and plan management
- **WebhookLogs**: Debugging and monitoring

## 🔐 Security Features

- **Environment-based secrets**: No hardcoded credentials
- **JWT authentication**: Secure API access
- **Internal API keys**: Module-to-module communication
- **Webhook signature verification**: Platform authenticity
- **Input validation**: Zod schemas prevent injection
- **Rate limiting**: Per-endpoint and per-user limits
- **SQL injection protection**: Prisma ORM
- **XSS prevention**: Input sanitization
- **CORS configuration**: Origin whitelisting
- **Security headers**: Helmet middleware

## 📈 Monitoring & Logging

- **Structured logging**: Winston with JSON format
- **Request tracing**: Unique request IDs
- **Health checks**: Database and Redis status
- **Error tracking**: Comprehensive error logging
- **Performance metrics**: Response times and API calls
- **User action logging**: Audit trail
- **Webhook processing logs**: Debugging support

## 🚀 Production Deployment

### Docker Deployment

1. **Build and deploy**:
```bash
docker-compose -f docker-compose.yml up -d
```

2. **Monitor services**:
```bash
docker-compose logs -f api
docker-compose ps
```

### Environment Setup

1. **Configure environment variables** in production
2. **Set up SSL certificates** for HTTPS
3. **Configure monitoring and alerts**
4. **Set up log aggregation** (optional Fluentd included)
5. **Configure backup strategies** for PostgreSQL

### Performance Optimization

- **Multi-stage Docker builds**: Minimal production images
- **Connection pooling**: Database and Redis
- **Compression**: Gzip for API responses
- **Caching**: Redis for session state and temporary data
- **Rate limiting**: Prevent abuse and ensure fair usage

## 🔧 Troubleshooting

### Common Issues

1. **Database connection errors**: Check DATABASE_URL and PostgreSQL status
2. **Redis connection errors**: Verify REDIS_URL and Redis service
3. **OpenAI API errors**: Validate OPENAI_API_KEY and check quotas
4. **Webhook delivery failures**: Verify webhook URLs and signatures

### Debugging

- Check logs in `./logs/` directory
- Use health check endpoint: `GET /health`
- Monitor webhook logs: `GET /gateway/webhook-logs`
- Review error logs for detailed stack traces

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Ensure all security checks pass
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

## 🆘 Support

For support and questions:
- Check the health endpoint: `/health`
- Review API documentation: `/docs`
- Check application logs
- Create an issue in the repository

---

Built with ❤️ for English language learners worldwide.

**Production Ready Features:**
✅ Comprehensive error handling
✅ Security hardening
✅ Performance optimization
✅ Monitoring and logging
✅ Scalable architecture
✅ Docker containerization
✅ Environment-based configuration
✅ Database transactions
✅ Rate limiting
✅ Input validation
✅ Webhook security
✅ Graceful shutdown
✅ Health checks