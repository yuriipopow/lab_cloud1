FROM node:20.12.2-bookworm-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
USER node

EXPOSE 3000
CMD ["node", "src/index.js"]
