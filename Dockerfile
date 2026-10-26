# ─────────────────────────────────────────────────────────────────────────────
# Flash Sale API — Dockerfile
# Pertemuan 2: Containerization (Docker)
# Kelompok 1, Cloud Computing H7D.7
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:18-alpine AS deps

WORKDIR /app

# Salin manifest dan instal HANYA production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:18-alpine AS runtime

RUN apk add --no-cache wget

WORKDIR /app

# Salin node_modules dari stage deps (bukan dari host)
COPY --from=deps /app/node_modules ./node_modules

# Salin source code aplikasi
COPY src/       ./src/
COPY frontend/  ./frontend/
COPY db/        ./db/
COPY scripts/   ./scripts/
COPY package.json ./

# User non-root untuk keamanan
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Port yang diekspos oleh backend (dikonfigurasi lewat env PORT)
EXPOSE 3000

# Healthcheck: cek endpoint /health setiap 15 detik
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
