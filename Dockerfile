# Use a Node image that includes the necessary libraries for Puppeteer
FROM ghcr.io/puppeteer/puppeteer:21.5.2

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Expose port
EXPOSE 3000

# Start the app
CMD [ "node", "server.js" ]