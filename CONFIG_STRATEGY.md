# Configuration Strategy (POC OpenWebUI + OpenRouter + Elysia)

## Goal
Make configuration predictable, secure, and debuggable across local Docker and Kubernetes.

## Configuration Layers (Highest precedence first)
1. **Runtime DB config (`system_config`)**
   - Updated via Admin Dashboard (`/admin/config`)
   - Broadcast to all replicas via Redis pub/sub
   - **Takes effect immediately** (runtime override)

2. **Environment variables at startup (K8s Secret/ConfigMap or `.env`)**
   - Loaded when pod/container starts
   - Used as bootstrap defaults and required values

3. **Code defaults**
   - Disabled for required values (fail-fast)
   - App throws explicit error if required config is missing

---

## What goes where

### Secret (sensitive)
- `OPENROUTER_API_KEY`
- `ADMIN_API_KEY`
- Any DB/Redis password if separate from URL

### ConfigMap (non-sensitive)
- `OPENROUTER_HTTP_REFERER`
- `OPENROUTER_X_TITLE`
- `LOG_MODE`
- Non-sensitive service URLs and toggles

### `.env` (local development only)
- Local equivalent of Secret/ConfigMap values
- Never commit real secrets to git

---

## Required middleware configs
- `OPENROUTER_API_KEY`
- `ADMIN_API_KEY`
- `OPENROUTER_HTTP_REFERER`
- `OPENROUTER_X_TITLE`
- `LOG_MODE`
- `REDIS_URL`
- `DATABASE_URL`
- `WEBUI_DATABASE_URL`

If any required value is missing, middleware fails with a clear `Missing required config: ...` error.

---

## Runtime update behavior
- Admin updates config via `/admin/config`
- Middleware writes to `system_config`
- Middleware publishes `middleware:config:updated` on Redis
- All replicas reload config from DB

This gives **cluster-wide realtime config sync** without pod restart.

---

## Operational recommendations
1. Keep **secrets in Secret** as source-of-truth for bootstrap.
2. Use dashboard runtime config for fast tuning/ops changes.
3. Periodically export/backup `system_config`.
4. Restrict who can access `/admin/config`.
5. Audit config updates (who/when/what changed) in future enhancement.

---

## Troubleshooting quick checks
- Verify middleware config view:
  - `GET /admin/config`
- Verify health:
  - `GET /admin/health`
- Verify realtime sync:
  - Update one key in dashboard, then re-open `/admin/config` and compare across pods.

