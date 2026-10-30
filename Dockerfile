# Base image with Node.js LTS and FFmpeg
FROM node:20-alpine

# Install FFmpeg & required system libraries for media processing
RUN apk add --no-cache ffmpeg python3 make g++

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Expose backend port
EXPOSE 5001

# Default environment settings
ENV NODE_ENV=production
ENV PORT=5001

# Start backend server
CMD ["node", "server.js"]
