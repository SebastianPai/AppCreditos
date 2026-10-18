# Capital Control — imagen de producción (Next.js + migraciones PostgreSQL)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/db ./db
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/next.config.ts ./
USER node
EXPOSE 3000
# Aplica migraciones pendientes y arranca el servidor.
CMD ["sh", "-c", "node scripts/migrate.mjs && npm start"]
