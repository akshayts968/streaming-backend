# Antigravity Stream - Backend API & Media Pipeline

A high-performance streaming backend built with Node.js, Express 5, MongoDB, Upstash Redis, BullMQ, and FFmpeg. Features progressive Telegram remuxing, secure AES-128 HLS transcoding, multi-audio and multi-language subtitle tracks, and hover storyboard sprite generation.

---

## 🚀 Key Features

* **Progressive Range Streaming (`/api/videos/stream-tg/:id`)**: High-speed chunked byte-range remuxing directly from Telegram MTProto with zero disk caching bottlenecks.
* **Anti-Direct-Download Protection**: Blocks top-level browser navigation downloads and download managers while allowing seamless playback in HTML5 video players.
* **AES-128 HLS Media Pipeline (`/api/v1/stream/...`)**: BullMQ worker running FFmpeg with AES-128 segment encryption, HMAC token validation, and multi-resolution variants (360p, 480p, 720p, 1080p).
* **Multi-Language Subtitles & Audio**: Dynamic track discovery with support for continuous WebVTT dialogue in English and Malayalam (`/api/videos/subtitles/:id/:lang.vtt`).
* **Storyboard Thumbnail Previews**: VTT-indexed sprite sheets generating hover thumbnail previews across the entire 2.5-hour seek bar (`/api/videos/storyboard/:id/...`).
* **Telegram Bot & MTProto Listener**: Automated video ingestion and channel listening with auto-generated video entries and thumbnails.
* **Rate Limiting & Caching**: Upstash Redis distributed caching and sliding-window rate limiters.

---

## 🛠️ Tech Stack

* **Runtime**: Node.js 20+ (Alpine in Docker)
* **Framework**: Express 5.x
* **Database**: MongoDB with Mongoose ODM
* **Cache & Queues**: Redis (Upstash / IORedis) & BullMQ
* **Media Processing**: FFmpeg & FFprobe
* **Containerization**: Docker & Docker Compose

---

## 📦 Installation & Local Setup

### Prerequisites
* Node.js v20+
* MongoDB URI
* Redis instance

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/akshayts968/streaming-backend.git
cd streaming-backend
npm install
```

### 2. Environment Variables (`.env`)
Create a `.env` file in the root directory:
```env
PORT=5001
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret_key
FRONTEND_URL=http://localhost:3000

# Telegram MTProto Ingestion
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_SESSION=your_session_string

# Redis
REDIS_URL=rediss://default:your_redis_token@your_redis_host:6379
```

### 3. Run Locally
```bash
# Development (with nodemon)
npm run dev

# Production
npm start
```

---

## 🐳 Docker Deployment

You can build and run the backend container standalone:

```bash
# Build the Docker image
docker build -t antigravity-backend:latest .

# Run container
docker run -d \
  --name antigravity-backend \
  -p 5001:5001 \
  --env-file .env \
  -v $(pwd)/public/subtitles:/app/public/subtitles \
  -v $(pwd)/public/storyboards:/app/public/storyboards \
  -v $(pwd)/public/hls:/app/public/hls \
  antigravity-backend:latest
```

Or run using Docker Compose with the frontend:
```bash
docker compose up -d
```

---

## 📡 API Endpoints Overview

| Endpoint | Method | Description |
|---|---|---|
| `/api/videos` | `GET` | Fetch all published movies |
| `/api/videos/:id` | `GET` | Get single video metadata by ID or slug |
| `/api/videos/stream-tg/:id` | `GET` | Progressive range stream from Telegram |
| `/api/videos/hls/:id/tracks.json` | `GET` | List available audio & subtitle tracks |
| `/api/videos/subtitles/:id/:lang.vtt` | `GET` | WebVTT subtitle stream |
| `/api/videos/storyboard/:id/storyboard.vtt` | `GET` | Storyboard sprite manifest |
| `/api/videos/storyboard/:id/:sprite` | `GET` | Storyboard JPEG image tile |
| `/api/v1/stream/manifest/:id` | `GET` | Secure encrypted HLS master playlist |
| `/api/v1/stream/token/:id` | `POST` | Generate playback session token |
| `/api/v1/stream/key/:id` | `GET` | AES-128 decryption key (authenticated) |
