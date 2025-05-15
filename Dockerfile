FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY package.json .
COPY requirements.txt .
ENV HUSKY=0
RUN npm cache clean --force && \
    npm install debug@4.3.7 && \
    npm install && \
    pip cache purge && \
    python3.12 -m pip install --no-cache-dir -r requirements.txt

COPY . .
EXPOSE 10000
CMD ["node", "server.js"]