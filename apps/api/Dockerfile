FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/api apps/api
RUN npm run build --workspace=api

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /workspace/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
COPY apps/api/scripts apps/api/scripts
WORKDIR /workspace/apps/api
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
