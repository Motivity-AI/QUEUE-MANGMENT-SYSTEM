FROM node:20-slim
WORKDIR /app

# تثبيت الحزم
COPY package*.json ./
RUN npm ci --omit=dev

# نسخ الكود
COPY . .

# مجلد البيانات
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/queue.db

EXPOSE 3000
CMD ["node", "server.js"]