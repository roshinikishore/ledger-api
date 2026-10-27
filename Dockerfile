FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# The SQLite file lives in /data so it can be kept on a persistent disk.
ENV PORT=3000 DB_FILE=/data/ledger.db
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
