# Node 24 (active LTS). Node 20 reached end of life in April 2026.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
# better-sqlite3 ships a native binary. Alpine doesn't include the build
# toolchain by default — install python3/make/g++ for the install step,
# then drop them so the runtime image stays slim.
RUN apk add --no-cache python3 make g++ \
	&& npm ci \
	&& apk del python3 make g++
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/build build/
COPY --from=builder /app/node_modules node_modules/
COPY package.json .
EXPOSE 3001
ENV PORT=3001
# The runtime reads NODE_ENV to pick its defaults; without it the SQLite
# database landed inside the container (./local-data) whenever DATABASE_PATH
# was not set, and vanished on the next rebuild. Set only here, after the
# build: in the builder it would make npm skip the devDependencies.
ENV NODE_ENV=production
# Attachments go up to 25 MB (api/upload), plus multipart overhead.
# Signed-out requests are still held to 1 MB in hooks.server.ts.
ENV BODY_SIZE_LIMIT=30M
CMD ["node", "build"]
