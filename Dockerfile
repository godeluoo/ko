FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

RUN chmod +x /app/bin/web-linux-amd64 /app/bin/bot-linux-amd64

EXPOSE 3000

CMD ["npm", "start"]
