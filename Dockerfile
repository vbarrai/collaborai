# Build stage — compile TypeScript to plain JS so the runtime needs no tsx.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage — production deps only.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Persistent state (config + secrets) lives here; mount a volume on it.
ENV COLLABORAI_HOME=/data
VOLUME ["/data"]
EXPOSE 8080

# Default: no-Slack mode. Override with `--slack` (and provide Slack tokens) to
# run the Slack front-end: `docker run ... node dist/server/index.js --slack`.
CMD ["node", "dist/server/index.js"]
