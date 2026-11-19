FROM node:22-alpine
ENV NODE_ENV=production PORT=8765 WS_PATH=/signal
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
USER node
EXPOSE 8765
CMD ["node", "server.js"]
