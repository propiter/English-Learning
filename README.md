# English Learning SaaS Backend

A comprehensive backend system for an English conversational learning platform that integrates with Telegram and WhatsApp, providing AI-powered feedback and personalized learning experiences.

## 🏗️ Architecture Overview

The system is built with a modular architecture consisting of 6 main modules:

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
- External API integrations

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
- New user onboarding flow
- Initial level assessment
- Interest and goal collection
- Level-up test management

## 🚀 Key Features

- **Multi-Platform Support**: Telegram and WhatsApp integration
- **AI-Powered Feedback**: OpenAI GPT-4 and TTS integration
- **CEFR Level System**: A0-C2 level progression
- **Gamification**: XP, streaks, and achievements
- **Personalization**: Interest-based content and learning goals
- **Real-time Processing**: Async message handling
- **Comprehensive Analytics**: Learning progress and performance tracking
- **Scalable Architecture**: Modular design with internal APIs

## 🛠️ Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Cache**: Redis
- **AI Services**: OpenAI GPT-4 and Whisper
- **Authentication**: JWT
- **Validation**: Joi
- **Logging**: Winston
- **Containerization**: Docker

## 📦 Installation

### Prerequisites
- Node.js 18+
- PostgreSQL 15+
- Redis 7+
- Docker (optional)

### Local Development Setup

1. **Clone and install dependencies**:
```bash
git clone <repository-url>
cd english-learning-backend
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

### Docker Setup

1. **Using Docker Compose**:
```bash
docker-compose up -d
```

This will start:
- API server on port 3000
- PostgreSQL on port 5432
- Redis on port 6379
- Nginx reverse proxy on ports 80/443

## 🔧 Configuration

### Required Environment Variables

```env
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/english_learning_db"

# Redis
REDIS_URL="redis://localhost:6379"

# Security
JWT_SECRET="your-jwt-secret"
INTERNAL_API_KEY="your-internal-api-key"

# OpenAI
OPENAI_API_KEY="your-openai-api-key"

# Telegram
TELEGRAM_BOT_TOKEN="your-telegram-bot-token"

# WhatsApp
WHATSAPP_ACCESS_TOKEN="your-whatsapp-token"
WHATSAPP_API_URL="https://graph.facebook.com/v18.0/YOUR_PHONE_NUMBER_ID"
```

## 📡 API Endpoints

### User Management
- `POST /api/users/register` - Register new user
- `GET /api/users/:id` - Get user profile
- `PUT /api/users/:id` - Update user profile
- `GET /api/users/:id/progress` - Get learning progress

### Learning Sessions
- `POST /api/learning/sessions` - Create learning session
- `GET /api/learning/users/:userId/sessions` - Get session history
- `GET /api/learning/users/:userId/analytics` - Get learning analytics

### Content Management
- `GET /api/content/prompts` - Get AI prompts
- `GET /api/content/daily-topic` - Get daily practice topic

### Messaging
- `POST /api/gateway/webhook/telegram` - Telegram webhook
- `POST /api/gateway/webhook/whatsapp` - WhatsApp webhook

### Orchestrator
- `POST /api/orchestrator/process-message` - Process user message

## 🔄 Main User Flow

1. **User sends voice message** → Messaging Gateway receives webhook
2. **Gateway processes** → Extracts user data and forwards to Orchestrator
3. **Orchestrator coordinates**:
   - Gets user profile
   - Transcribes audio (Whisper)
   - Evaluates speech (external API)
   - Generates AI feedback (GPT-4 + TTS)
   - Saves session data
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

## 🔐 Security

- JWT authentication for API access
- Internal API key for module communication
- Webhook signature verification
- Input validation with Joi
- SQL injection protection with Prisma
- Rate limiting and CORS configuration

## 📈 Monitoring & Logging

- Structured logging with Winston
- Health check endpoints
- Error tracking and reporting
- Performance metrics
- Webhook processing logs

## 🚀 Deployment

### Production Deployment

1. **Build the application**:
```bash
npm run build
```

2. **Deploy with Docker**:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

3. **Set up reverse proxy** (Nginx configuration included)

4. **Configure SSL certificates**

5. **Set up monitoring and alerts**

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

## 🆘 Support

For support and questions:
- Create an issue in the repository
- Check the documentation
- Review the API endpoints

---

Built with ❤️ for English language learners worldwide.