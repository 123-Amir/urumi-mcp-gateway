# syntax=docker/dockerfile:1
# Stage 1: install ONLY production dependencies from the lockfile (reproducible; no devDependencies in the final image).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: small runtime image. No npm, no shell scripts, no build tools needed at runtime.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Numeric non-root user. Kubernetes `runAsNonRoot` can only verify a NUMERIC uid, and the chart pins the same value.
USER 10001:10001
EXPOSE 8080
# node:sqlite is still flagged "experimental" in Node 22; the flag only silences the warning line.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
