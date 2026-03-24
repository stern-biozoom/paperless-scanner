# Use Bun's official base image which includes both Bun and Node.js
FROM oven/bun:latest AS builder
WORKDIR /usr/src/app

# Copy only package files first for better caching
COPY package.json tsconfig.json ./
COPY .env* ./

# Copy static templates into the build context so they are baked into the image
COPY templates ./templates

# Copy app files (type=module + TypeScript source files)
COPY . .

# Install dependencies
RUN bun install --production

FROM oven/bun:latest AS runtime
WORKDIR /usr/src/app

# Install system dependencies required for SANE/scanning tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends sane-utils libsane1 ca-certificates curl img2pdf \
  && rm -rf /var/lib/apt/lists/*

# Copy app from builder
COPY --from=builder /usr/src/app /usr/src/app

# Expose application port
EXPOSE 3000

# Fix Bun runtime permissions and ensure required folders exist
RUN mkdir -p /tmp && chown -R root:root /usr/src/app

# Make entrypoint executable (entrypoint ensures a config directory and default config.json)
RUN chmod +x /usr/src/app/entrypoint.sh || true

# Copy templates to a stable location that won't be masked by mounting /usr/src/app
COPY --from=builder /usr/src/app/templates /usr/share/paperless-scanner/templates
RUN mkdir -p /usr/share/paperless-scanner/templates && chown -R root:root /usr/share/paperless-scanner
# Create a persistent config directory that can be mounted by the host
RUN mkdir -p /usr/src/app/config
VOLUME ["/usr/src/app/config"]

# Default command: run the entrypoint which prepares config and starts the app
CMD ["/usr/src/app/entrypoint.sh"]
