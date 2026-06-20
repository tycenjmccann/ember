# Cloud Code — Next.js standalone image for App Runner.
FROM node:22-alpine AS base

# Install all deps (incl. dev) for the build.
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Production image — just the standalone server + static assets.
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
# App Runner injects its own HOSTNAME at launch; Next.js standalone binds to it,
# which breaks the health check on 127.0.0.1:8080. Force 0.0.0.0 (deploy.sh also
# sets this as a runtime env var so it wins over any launch-time injection).
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

RUN mkdir -p /app/.next/cache && chown -R nextjs:nodejs /app/.next/cache

USER nextjs
EXPOSE 8080

CMD ["node", "server.js"]
