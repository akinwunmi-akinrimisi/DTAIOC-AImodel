FROM python:3.12-slim

WORKDIR /app

# Install Node.js
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy package.json and install Node.js dependencies
COPY package.json .
ENV HUSKY=0
RUN npm install && \
    pip cache purge && \
    python3.12 -m pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Expose port
EXPOSE 10000

# Start the application
CMD ["node", "server.js"]