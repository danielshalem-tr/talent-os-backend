# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY . .
RUN npm run build

# ─── Stage 2: Production runner ───────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Install production deps only (smaller image)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Copy Prisma schema for migrations (prisma generate needs schema at runtime)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

EXPOSE 3000

# Default command starts the API server
# Worker overrides this in docker-compose.yml with: command: node dist/src/worker.js
# Note: nest build outputs to dist/src/ because tsconfig.json baseUrl is ./ (project root)
CMD ["node", "dist/src/main.js"]
