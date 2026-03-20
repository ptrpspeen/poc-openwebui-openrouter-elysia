# AI Control Plane (OpenWebUI + OpenRouter Middleware)

High-performance, scalable middleware designed to manage OpenWebUI traffic to OpenRouter API with enterprise-grade features like auto-provisioning, global quota tracking, and shared storage.

## 🚀 Key Features

- **High Performance:** Built with [Bun](https://bun.sh/) and [ElysiaJS](https://elysiajs.com/), capable of handling **15,000+ requests per second**.
- **Auto-Provisioning:** Automatically registers new users from OpenWebUI headers/JWT upon their first request.
- **Global Quota Tracking:** Real-time token usage enforcement across multiple nodes using **Redis**.
- **Persistence:** Durable storage for users, policies, and detailed usage logs using **PostgreSQL**.
- **Scalable UI:** OpenWebUI is configured for horizontal scaling using **MinIO** as a shared object storage for files and assets.
- **Admin Control Plane:** Secured API endpoints for managing users, policies, and monitoring usage.
- **Kubernetes Ready:** Includes manifests for full-cluster deployment with HPA (Horizontal Pod Autoscaler).

## 🏗 Architecture

```mermaid
graph TD
    User([User]) --> WebUI[OpenWebUI Nodes 1..N]
    WebUI --> MinIO[(MinIO Shared Storage)]
    WebUI --> MW[AI Middleware Nodes 1..N]
    MW --> Redis{Redis Hot Path}
    MW --> Postgres[(PostgreSQL Persistence)]
    MW --> OpenRouter[OpenRouter AI API]
    Redis -- "Atomic DECR" --> MW
    MW -- "Async Batch" --> Postgres
```

## ⚙️ Configuration Guide

> Recommended strategy and precedence: see `CONFIG_STRATEGY.md`

The system manages configurations differently based on the deployment environment.

### 1. Variables Overview

| Variable | Description | Type | Recommended Storage |
|----------|-------------|------|---------------------|
| `OPENROUTER_API_KEY` | Your OpenRouter API Key | Sensitive | Secret |
| `ADMIN_API_KEY` | Secret key for Dashboard access | Sensitive | Secret |
| `DATABASE_URL` | Postgres URL for Middleware DB | Config | ConfigMap |
| `WEBUI_DATABASE_URL` | Postgres URL for OpenWebUI DB | Config | ConfigMap |
| `REDIS_URL` | Redis connection URL | Config | ConfigMap |
| `LOG_MODE` | Log verbosity (`metadata` or `off`) | Config | ConfigMap |
| `OPENROUTER_HTTP_REFERER` | Site URL for OpenRouter ranking | Metadata | ConfigMap |
| `OPENROUTER_X_TITLE` | Site Name for OpenRouter ranking | Metadata | ConfigMap |

### 2. Kubernetes Configuration (Recommended)

In K8s, we separate sensitive data into **Secrets** and non-sensitive data into **ConfigMaps**.

#### Update Secrets (API Keys)
```bash
kubectl create secret generic ai-secrets \
  --from-literal=OPENROUTER_API_KEY=sk-or-v1-xxxx \
  --from-literal=ADMIN_API_KEY=your-secure-admin-key \
  --dry-run=client -o yaml | kubectl apply -f -
```

#### Update ConfigMap (URLs & Metadata)
Edit `k8s/middleware.yaml` or use:
```bash
kubectl create configmap middleware-config \
  --from-literal=DATABASE_URL=postgresql://admin:pass@db:5432/ai_control \
  --from-literal=WEBUI_DATABASE_URL=postgresql://admin:pass@db:5432/openwebui \
  --dry-run=client -o yaml | kubectl apply -f -
```

**Note:** Always run `kubectl rollout restart deployment middleware` after updating configurations.

### 3. Docker Compose Configuration

For local development or single-node Docker, use the `.env` file in the root directory.

```ini
OPENROUTER_API_KEY=sk-or-v1-xxxx
ADMIN_API_KEY=admin-secret-key
DATABASE_URL=postgresql://admin:adminpassword@db:5432/ai_control
WEBUI_DATABASE_URL=postgresql://admin:adminpassword@db:5432/openwebui
REDIS_URL=redis://redis:6379
LOG_MODE=metadata
```

## 🚦 Deployment

### 1. Kubernetes

All manifests are located in the `/k8s` directory.

```bash
# Apply all components
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/minio.yaml
kubectl apply -f k8s/middleware.yaml
kubectl apply -f k8s/openwebui.yaml

# Access the services
kubectl port-forward svc/openwebui-service 3000:80
kubectl port-forward svc/middleware-service 8080:8080
```

### 2. Docker Compose

```bash
docker-compose up -d --build
```

## 🔐 Admin Dashboard

The built-in dashboard is available at `http://localhost:8080`.
- **Authentication:** Requires the `ADMIN_API_KEY` defined in your configuration.
- **Features:** Real-time User Hub, Group-to-Policy Mapping, Quota Management, and Usage Audit Logs.

## 📊 Performance Benchmarks (Middleware)

Tested on local Kubernetes cluster (5 replicas):
- **Requests per Second:** ~15,421 req/sec
- **Average Latency:** 31.5 ms
- **Success Rate:** 100%

---
Developed as a POC for scalable AI infrastructure.
