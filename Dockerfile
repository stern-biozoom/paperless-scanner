# Use Bun's official base image which includes both Bun and Node.js
FROM oven/bun:latest AS builder
WORKDIR /usr/src/app

# Copy only package files first for better caching
COPY package.json tsconfig.json ./
COPY .env* ./

# Copy app files (type=module + TypeScript source files)
COPY . .

# Install dependencies
RUN bun install --production

FROM oven/bun:latest AS runtime
WORKDIR /usr/src/app

# Install system dependencies required for SANE/scanning tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends sane-utils libsane1 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Copy app from builder
COPY --from=builder /usr/src/app /usr/src/app

# Expose application port
EXPOSE 3000

# Fix Bun runtime permissions and ensure required folders exist
RUN mkdir -p /tmp && chown -R root:root /usr/src/app

# Default command: run the main TypeScript entry with Bun
CMD ["bun", "index.ts"]
