# OpenWebUI + OpenRouter Middleware (ElysiaJS)

Middleware proxy สำหรับเชื่อม OpenWebUI กับ OpenRouter API พร้อม user tracking และ usage monitoring

## Features

- ✅ Proxy requests จาก OpenWebUI ไปยัง OpenRouter
- ✅ User tracking (inject `user` field จาก JWT หรือ OpenWebUI headers)
- ✅ SSE stream usage sniffing (log token usage)
- ✅ Header cleaning (ตัด hop-by-hop headers, sensitive headers)
- ✅ Lightweight — Bun + ElysiaJS

## Tech Stack

- **Runtime:** [Bun](https://bun.sh/)
- **Framework:** [ElysiaJS](https://elysiajs.com/)
- **Container:** Docker (Alpine)

## Quick Start

### Docker Compose (Recommended)

```bash
# Copy .env.example to .env and set OPENROUTER_API_KEY
cp .env.example .env

# Run
docker-compose up --build
```

- **OpenWebUI:** http://localhost:3000
- **Middleware:** http://localhost:8080

### Local Development

```bash
cd middleware
bun install
bun run dev
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENROUTER_API_KEY` | OpenRouter API Key | ✅ |
| `OPENROUTER_HTTP_REFERER` | HTTP Referer for OpenRouter | ❌ |
| `OPENROUTER_X_TITLE` | X-Title header for OpenRouter | ❌ |
| `LOG_MODE` | `metadata` or `off` | ❌ (default: `metadata`) |

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  OpenWebUI  │────▶│  Middleware │────▶│ OpenRouter  │
│  :3000      │     │  :8080      │     │   API       │
└─────────────┘     └─────────────┘     └─────────────┘
                          │
                          ▼
                    User Tracking
                    Usage Logging
```

## License

MIT
