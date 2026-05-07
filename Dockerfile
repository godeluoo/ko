FROM node:alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

EXPOSE 3000/tcp

CMD ["node", "--max-old-space-size=64", "--optimize-for-size", "index.js"]
