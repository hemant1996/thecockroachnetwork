# Cockroach Relay — minimal container image.
# Build: docker build -t cockroach-relay .
# Run:   docker run -p 7447:7447 -v $(pwd)/data:/data cockroach-relay

FROM oven/bun:1.3-alpine

WORKDIR /app

# Install deps first (cached layer).
# Match both the new text-format lockfile (bun.lock, Bun >=1.1) and the legacy
# binary lockfile (bun.lockb) — Bun's --frozen-lockfile silently no-ops when no
# lockfile is present in the build context, so the glob MUST match the real
# filename or every container build resolves dependencies unpinned.
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Source
COPY lib.ts server.ts ./

# Data dir for SQLite — mount a volume here in production
RUN mkdir -p /data && chown -R bun:bun /data
USER bun

ENV PORT=7447
ENV DB=/data/relay.db
ENV RETENTION_DAYS=90

EXPOSE 7447

CMD ["bun", "run", "server.ts"]
