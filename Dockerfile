# Use a base image with both Node.js and Python
FROM nikolaik/python-nodejs:python3.12-nodejs22

# Set working directory
WORKDIR /app

# Copy package.json and requirements.txt
COPY package.json requirements.txt ./

# Install Node.js and Python dependencies
RUN npm install && python3.12 -m pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Expose port 3000
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]