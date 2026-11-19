# Базовий образ із зафіксованою версією: Node 20.12.2 на Debian 12 (bookworm), slim-варіант
FROM node:20.12.2-bookworm-slim

ENV NODE_ENV=production
WORKDIR /usr/src/app

# Кореневий сертифікат RDS — для TLS-з'єднання з базою з перевіркою сертифіката
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/certs/rds-global-bundle.pem
RUN chmod 755 /opt/certs && chmod 644 /opt/certs/rds-global-bundle.pem

# Спершу лише маніфести залежностей: шар з node_modules перебудовується
# тільки при зміні package*.json, а не при кожній зміні коду
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/

# Процес працює від непривілейованого користувача node (uid 1000), не від root
USER node

EXPOSE 3000
CMD ["node", "src/index.js"]
