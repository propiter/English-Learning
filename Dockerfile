FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY prisma/ ./prisma/

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Create logs directory
RUN mkdir -p logs

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

# Change ownership of the app directory
RUN chown -R nextjs:nodejs /app
USER nextjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]