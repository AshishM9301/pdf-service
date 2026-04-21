FROM node:22-slim

RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium
RUN wget -q -O /tmp/chromium.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
    && apt-get install -y /tmp/chromium.deb \
    && rm /tmp/chromium.deb \
    && apt-get clean

# Set environment variables for Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV PUPPETEER_NO_SANDBOX=1
ENV PUPPETEER_NO_CHROMIUM_DOWNLOAD=1

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]