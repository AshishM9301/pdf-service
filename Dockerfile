# Use pre-built Chromium for cloud deployment
FROM node:20-slim

WORKDIR /app

# Install dependencies for Puppeteer and PDF manipulation
RUN apt-get update && apt-get install -y \
    libc6 \
    libgcc1 \
    libstdc++6 \
    libgssapi-krb5-2 \
    libkrb5-3 \
    libnss3 \
    libnss3-tools \
    libnspr4 \
    libdbus-1-3 \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libpython3.11 \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Puppeteer with @sparticuz/chromium (bundled Chromium)
COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Puppeteer will find the bundled Chromium automatically
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
ENV PUPPETEER_NO_SANDBOX=1

EXPOSE 3000

CMD ["node", "dist/server.js"]