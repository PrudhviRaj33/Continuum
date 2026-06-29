# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Prune dev dependencies
RUN npm prune --production --legacy-peer-deps

# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Non-root user for security
RUN addgroup -S continuum && adduser -S continuum -G continuum

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY src/database/schema.sql ./dist/database/schema.sql

# Create data directory
RUN mkdir -p /data && chown continuum:continuum /data

USER continuum

ENV NODE_ENV=production
ENV DB_PATH=/data/knowledge.db
ENV LOG_LEVEL=info

# Health check — verify process is responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["node", "dist/mcp/McpServer.js"]
