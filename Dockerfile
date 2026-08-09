FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    ABI_HOST=0.0.0.0 \
    ABI_PORT=8787

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
RUN mkdir -p /app/var && chown node:node /app/var

USER node

EXPOSE 8787

CMD ["node", "dist/app/index.js"]
