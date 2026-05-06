FROM node:22-alpine3.23

WORKDIR /tmp

COPY . .

RUN apk add --no-cache \
    openssl \
    curl \
    wget \
    gcompat \
    iproute2 \
    coreutils \
    bash \
    ca-certificates \
    tar \
    gzip \
    jq \
    && chmod +x index.js \
    && npm install --omit=dev \
    && npm cache clean --force

EXPOSE 3000/tcp

CMD ["node", "index.js"]
