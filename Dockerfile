# Use a Node image that includes the necessary libraries for Puppeteer
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root user temporarily to install dependencies and fix permissions
USER root

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# GRANT PERMISSION: Give the 'pptruser' ownership of this folder so it can save PDFs
RUN chown -R pptruser:pptruser /usr/src/app

# Switch back to the secure user provided by the image
USER pptruser

# Expose port
EXPOSE 3000

# Start the app
CMD [ "node", "server.js" ]