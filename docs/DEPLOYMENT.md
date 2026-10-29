# Converge: Production Cloud Deployment Architecture & Runbook

**Document Owner**: Staff Platform & DevOps Engineer  
**Target Architecture**: Vercel (Frontend Static Next.js) + Render (Backend Web Service) + Managed PostgreSQL + Attached Persistent Disk  
**Status**: Architecture Approved & Deployment Ready  

---

## 1. Hosting Architecture Overview

```
 ┌─────────────────────────────────────────────────────────────┐
 │                         PUBLIC INTERNET                     │
 └──────────────┬───────────────────────────────┬──────────────┘
                │ HTTPS (Port 443)              │ WSS / HTTPS (Port 443)
                ▼                               ▼
 ┌─────────────────────────────┐ ┌─────────────────────────────┐
 │       VERCEL EDGE CDN       │ │    RENDER CLOUD PROXY       │
 │    (Static Next.js SSG)     │ │    (Edge TLS Termination)   │
 │                             │ └──────────────┬──────────────┘
 │ • Static HTML, CSS, JS      │                │ Plain HTTP/WS (Internal PORT)
 │ • Monaco Editor assets      │                ▼
 │ • Semantic Guard Worker     │ ┌─────────────────────────────┐
 │ • IndexedDB offline store   │ │      RENDER WEB SERVICE     │
 └─────────────────────────────┘ │   Node.js (packages/server) │
                                 │                             │
                                 │ • Express HTTP APIs         │
                                 │ • WebSocket Room Authority  │
                                 │ • HMAC Capability Auth      │
                                 │ • In-Flight Mutex & HLC     │
                                 └───────┬─────────────┬───────┘
                                         │             │
                                         │             │ Local POSIX I/O
                  PostgreSQL Wire / TLS  │             ▼
                  (External / Internal)  │     ┌───────────────┐
                                         │     │ RENDER DISK   │
                                         ▼     │ (Persistent)  │
                               ┌─────────────┐ │ /data/leveldb │
                               │ MANAGED PG  │ └───────────────┘
                               │ (PostgreSQL │
                               │  15+ ACID)  │
                               └─────────────┘
```

### Architectural Separation
1. **Frontend (Vercel)**:
   - Next.js 15 App Router static export serving Monaco editor, Web Workers, and client UI.
   - Deployed at `https://<frontend-project>.vercel.app`.
   - Communicates strictly via `WSS` (WebSockets) and `HTTPS` (REST history API) to the Render backend.
2. **Backend (Render Web Service)**:
   - Node.js 22 runtime hosting `@converge/server`.
   - Single port architecture: Express HTTP API (`/health`, `/doc/:id/history`) and `WebSocketServer` share the platform-assigned `PORT`.
   - Edge TLS terminated automatically by Render at `https://<backend-service>.onrender.com` / `wss://<backend-service>.onrender.com`.
3. **Database (Managed PostgreSQL 15+)**:
   - Append-only canonical transaction history (`operations`, `doc_snapshots`, `durable_acks`).
   - Hosted on Render PostgreSQL, Supabase, Neon, or Railway with TLS enabled.
4. **Local Hot Cache (Render Persistent Disk)**:
   - Fast LevelDB key-value store mounted at `/data/leveldb`.
   - Preserves hot room caches across service restarts and redeployments.

---

## 2. Service Build & Execution Configurations

### 2.1 Backend Service (Render Web Service)
* **Root Directory**: `.` (Repository Root)
* **Environment**: `Node`
* **Node Version**: `22.x` (or set `NODE_VERSION=22.23.1`)
* **Build Command**:
  ```bash
  pnpm --filter server build
  ```
  *(Compiles TypeScript source from `packages/server/src` to `packages/server/dist` via `tsc`)*.
* **Start Command**:
  ```bash
  pnpm --filter server start
  ```
  *(Executes `node packages/server/dist/index.js`)*.
* **Health Check Path**:
  ```
  /health
  ```
  *(Responds with HTTP 200 `{"status":"ok","database":"healthy"}` without allocating room memory)*.
* **Port & Network Ingress**:
  - Render automatically provisions and injects `process.env.PORT` (typically `10000`).
  - The server strictly validates `PORT` as an integer between 1 and 65535, binding to `0.0.0.0:${PORT}` for container reverse-proxy ingress.
  - In local development, Converge safely falls back to `1234` only when `PORT` is absent.
  - Fail-early validation prevents `NaN`, empty strings, or out-of-range ports from reaching `server.listen()`. Do not define `PORT` manually in Render dashboard.

### 2.2 Frontend Service (Vercel)
* **Framework Preset**: `Next.js`
* **Root Directory**: `packages/client` (or Root directory with build filter)
* **Build Command**:
  ```bash
  pnpm --filter client build
  ```
* **Output Directory**: Automatically handled by Next.js preset (`.next`)
* **Node Version**: `20.x` or `22.x`

---

## 3. Environment Variables & Secret Separation

> [!CAUTION]
> Never commit real secrets to Git or configure server secrets with the `NEXT_PUBLIC_` prefix. `NEXT_PUBLIC_` variables are inlined into the client-side JavaScript bundle during build time.

### 3.1 Backend Variables (Render — Private Secrets)

| Variable | Type | Required | Description & Security Policy |
| :--- | :---: | :---: | :--- |
| `NODE_ENV` | String | **Yes** | Set to `production`. Enforces strict fail-closed security guards. |
| `PORT` | Integer | **Auto** | **Injected automatically by Render (e.g. `10000`)**. Do NOT add `PORT` manually in the Render dashboard or set it to an empty string. The server validates that `PORT` is an integer between 1 and 65535, falling back to `1234` only when absent (local development). Fails early if an explicit port is invalid. |
| `HOST` | String | Optional | Defaults to `0.0.0.0` (binds to all container network interfaces, required for Render reverse proxy ingress). |
| `DATABASE_URL` | Secret | **Yes** | Neon PostgreSQL connection string: `postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require`. |
| `DATABASE_SSL` | Boolean | Optional | Optional for Neon (auto-detected via `sslmode=require`), or set `true` for other providers. |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Boolean | Optional | **Keep `true` (default)**. Neon uses public DigiCert/Let's Encrypt CAs; certificate verification is enabled by default. Only set `false` in development with self-signed test databases. |
| `LEVELDB_DIR` | Path | **Yes** | Mount path on Render Persistent Disk: `/data/leveldb`. |
| `CONVERGE_AUTH_SECRET` | Secret | **Yes** | 64-character hex secret for HMAC-SHA256 capability tokens ($\ge 16$ chars). |
| `ADMIN_API_KEY` | Secret | **Yes** | 64-character hex secret protecting administrative snapshot and compaction endpoints. |
| `ALLOWED_ORIGINS` | String | **Yes** | Comma-separated list of allowed frontend origins: `https://<your-app>.vercel.app`. |
| `MAX_ROOMS` | Integer | Optional | Default `1000`. Limits concurrent active document rooms. |
| `MAX_TOTAL_CONNECTIONS` | Integer | Optional | Default `5000`. Server-wide connection ceiling. |
| `MAX_CLIENTS_PER_ROOM` | Integer | Optional | Default `100`. Limits concurrent connections per room. |
| `MAX_MESSAGES_PER_SEC` | Integer | Optional | Default `200`. Sliding-window rate limit per socket. |

### 3.2 Frontend Variables (Vercel — Public Inlined Variables)

> [!IMPORTANT]
> **Build-Time Inlining & Immutability**: In Next.js, `NEXT_PUBLIC_` environment variables are replaced with their literal values at **build time** (`pnpm build`). They are embedded directly into public client JS bundles (`.next/static/chunks/*.js`).
> - Any visitor can inspect network traffic or bundle sources and view these values.
> - **Never** prefix server secrets (`CONVERGE_AUTH_SECRET`, `ADMIN_API_KEY`, `DATABASE_URL`) with `NEXT_PUBLIC_`.
> - Changing a `NEXT_PUBLIC_` variable in the Vercel dashboard **does not** take effect on a running deployment until a **new deployment** is triggered.

| Variable | Type | Required | Description |
| :--- | :---: | :---: | :--- |
| `NEXT_PUBLIC_WS_URL` | Public | **Yes** | Secure WebSocket URL: `wss://<backend-service>.onrender.com`. Inlined at build time. |
| `NEXT_PUBLIC_HTTP_API_URL` | Public | Optional | Secure HTTP API URL: `https://<backend-service>.onrender.com` (defaults to replacing `wss://` with `https://`). |
| `NEXT_PUBLIC_ROOM_NAME` | Public | Optional | Default room identifier (defaults to `demo`). |
| `NEXT_PUBLIC_CONVERGE_TOKEN` | Public | **Yes** | Pre-signed visitor capability token scoped strictly to `demo` (see Section 4). |

---

## 4. Public Visitor Demo Credential Architecture

For a public SDE portfolio demonstration, external visitors must be able to test real-time collaboration without creating an account or requiring an interactive login flow.

### 4.1 Token Threat Model & Security Boundaries
Treat `NEXT_PUBLIC_CONVERGE_TOKEN` as a public credential delivered to every visiting browser:

| Security Vector | Implementation & Threat Mitigation |
| :--- | :--- |
| **Room Containment** | The token is strictly scoped to `room: "demo"` (or prefix `room: "demo-*"` for visitor-isolated scratchpads). Any attempt to access unauthorized rooms (`ws://host/internal-room`) is rejected with `4403 FORBIDDEN`. **Never mint with `room: "*"`**. |
| **Administrative Endpoints** | Administrative APIs (`POST /doc/:id/snapshot`, `POST /doc/:id/compact`) require `ADMIN_API_KEY` or `role: 'admin'`. The visitor token possesses `role: 'editor'`, so administrative calls fail with `401 UNAUTHORIZED`. |
| **History & Time-Travel** | `GET /doc/:id/history` requires `docAuthMiddleware`. Because the token is scoped to `demo`, visitors can inspect time-travel history for `demo`, but cannot query historical records for other rooms. |
| **Mandatory Expiration** | Tokens enforce a mandatory `exp` claim. When expired, the WebSocket handshake rejects the connection with `4401 UNAUTHORIZED` (`Authentication failed: TOKEN_EXPIRED`). |
| **Abuse & DoS Mitigation** | Even with the public token extracted: <br>• WebSocket Origin checks enforce `ALLOWED_ORIGINS` (`https://<your-app>.vercel.app`).<br>• Message rate limits enforce max 200 msgs/sec sliding window.<br>• Max clients per room caps room `demo` at 100 concurrent sockets.<br>• Max frame payload caps binary frames at 10 MB. |

### 4.2 Generating the Visitor Credential
Generate secrets and a scoped demo token from your local terminal:

```bash
# 1. Generate server secrets
CONVERGE_AUTH_SECRET=$(openssl rand -hex 32)
ADMIN_API_KEY=$(openssl rand -hex 32)
echo "Server Secret: $CONVERGE_AUTH_SECRET"
echo "Admin Key:     $ADMIN_API_KEY"

# 2. Mint the narrowly scoped visitor capability token (Valid for 180 days)
node -e "
const crypto = require('crypto');
const secret = '$CONVERGE_AUTH_SECRET';
const now = Date.now();
const claims = {
  sub: 'portfolio-visitor',
  role: 'editor',
  room: 'demo', // Narrow scope: strictly room 'demo' (or 'demo-*')
  iat: now,
  exp: now + 180 * 24 * 60 * 60 * 1000 // 180 days TTL
};
const b64 = Buffer.from(JSON.stringify(claims)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
console.log('\nVisitor Token (set as NEXT_PUBLIC_CONVERGE_TOKEN):\n' + b64 + '.' + sig);
"
```

### 4.3 Token Rotation & Renewal Strategy
1. **Planned Rotation**: Re-run the minting script above with a new 180-day expiration window.
2. **Update Vercel**: Paste the new token as `NEXT_PUBLIC_CONVERGE_TOKEN` in the Vercel dashboard.
3. **Trigger Redeployment**: Under Vercel $\to$ Deployments $\to$ click **Redeploy** so Next.js inlines the new token into the static JavaScript bundles.
4. **Emergency Invalidation**: If the visitor token is abused, change `CONVERGE_AUTH_SECRET` on Render. This immediately invalidates all active and existing capability tokens across the server.

---

## 5. Storage & Database Management (Neon PostgreSQL + Persistent Disk)

### 5.1 Neon Managed PostgreSQL Configuration
* **Provider**: [Neon](https://neon.tech) (Serverless PostgreSQL 15+).
* **TLS Configuration**:
  - Connection string format: `postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require`.
  - In `packages/server/src/db.ts`, Converge automatically detects Neon connection strings and enforces **TLS with certificate verification enabled** (`rejectUnauthorized: true`).
  - **Security Warning**: `DATABASE_SSL_REJECT_UNAUTHORIZED=false` must **NOT** be used with Neon. Neon's endpoints use valid public SSL certificates signed by Let's Encrypt / DigiCert. Disabling certificate verification exposes the database connection to Man-in-the-Middle (MITM) attacks.
* **Automatic Bootstrap**: Converge automatically runs `initDb()` on server startup, idempotently creating `operations`, `doc_snapshots`, and `durable_acks` tables and indexes.

### 5.2 Render Persistent Disk Configuration
* Under Render Web Service settings, add a **Disk**:
  - **Name**: `converge-leveldb-data`
  - **Mount Path**: `/data`
  - **Size**: `1 GB` (minimum; sufficient for tens of thousands of active documents).
* Set `LEVELDB_DIR=/data/leveldb` in Render environment variables.
* **Instance Count Constraint**: Render Persistent Disks require an instance count of **1**. Multiple instances cannot mount the same disk.
* **Cold Recovery Invariant**: Even if the disk is ever formatted or lost, Converge's PostgreSQL reconciliation architecture automatically queries canonical `operations` and snapshots on room boot to reconstruct the LevelDB hot cache.
  - `doc_snapshots`: Compacted checkpoints generated by `POST /doc/:id/compact`.
  - `durable_acks`: Primary key `(doc_id, update_id)` enforcing idempotent replay.

### 5.2 Render Persistent Disk Configuration
* Under Render Web Service settings, add a **Disk**:
  - **Name**: `converge-leveldb-disk`
  - **Mount Path**: `/data`
  - **Size**: `1 GB` (minimum; sufficient for tens of thousands of active documents).
* Set `LEVELDB_DIR=/data/leveldb` in Environment Variables.
* **Cold Recovery Invariant**: Even if the disk is ever formatted or lost, Converge's PostgreSQL reconciliation architecture automatically queries canonical `operations` and snapshots on room boot to reconstruct the LevelDB hot cache.

---

## 6. Health Checks, Logging & Monitoring

* **Health Check Path**: `/health`
  - Returns HTTP 200 with JSON payload:
    ```json
    {
      "status": "ok",
      "database": "healthy",
      "timestamp": "2026-10-29T19:50:00.000Z",
      "uptimeSeconds": 3600
    }
    ```
  - Validates active PostgreSQL pool connectivity (`SELECT 1`).
  - Safe for load-balancer polling every 10 seconds (allocates 0 rooms).
* **Render Logging**:
  - Search filter: `[security]`, `[postgres]`, `[room]`, `[lifecycle]`.
  - Authentication rejections log sanitized reasons (e.g. `INVALID_SIGNATURE`, `TOKEN_EXPIRED`), never token contents or secrets.

---

## 7. Rollback & Disaster Recovery Procedures

### 7.1 Frontend Rollback (Vercel)
1. Go to Vercel Dashboard $\to$ **Deployments**.
2. Locate the previous working deployment.
3. Click the three dots $\to$ **Instant Rollback**.
4. Traffic is immediately redirected to the prior build at the edge within seconds.

### 7.2 Backend Rollback (Render)
1. Go to Render Dashboard $\to$ **Web Service** $\to$ **Events**.
2. Locate the last successful deployment commit.
3. Click **Rollback to this deploy**.

### 7.3 Data Recovery & Replay
* Because every edit is stored as an immutable append-only row in PostgreSQL `operations`, point-in-time recovery is always possible.
* If in-memory state is corrupted, restarting the Render Web Service flushes memory and replays all operations from PostgreSQL storage upon the next connection.

---

## 8. Verified Hosting Costs & Operational Boundaries

| Component | Recommended Tier | Estimated Cost | Operational Nuance |
| :--- | :--- | :---: | :--- |
| **Vercel Frontend** | Hobby Tier | **Free** | Generous global edge CDN bandwidth, instant static asset delivery. |
| **Render Web Service** | Starter Tier | **\$7.00 / month** | **Required for WebSockets**. Render Free Tier spins down after 15m of inactivity, which drops live WebSocket sessions. Starter tier remains always-on. |
| **Render Disk** | 1 GB Persistent Disk | **\$0.25 / month** | Required to attach local disk for LevelDB. Persistent disks require Starter tier or higher. |
| **Neon PostgreSQL** | Free Tier | **Free** | Serverless compute with 0.5 GiB storage; includes public TLS certificates. Requires monitoring cold-start compute wakeups. |
| **Total Estimated Cost** | — | **~\$7.25 / mo** | Minimal footprint for an enterprise-grade collaborative distributed system. |

---

## 9. Pre-Flight Verification Summary

- [x] Backend dynamically binds to platform-assigned `PORT` on `0.0.0.0`.
- [x] Express and `ws` share the same HTTP server port (Render single-port ingress compatible).
- [x] Frontend `HistoryPane` dynamically targets `NEXT_PUBLIC_HTTP_API_URL` with bearer tokens.
- [x] Frontend `useYDoc` accepts `NEXT_PUBLIC_CONVERGE_TOKEN` or `NEXT_PUBLIC_CONVERGE_AUTH_TOKEN`.
- [x] Backend database pool enforces TLS with certificate verification (`rejectUnauthorized: true`).
- [x] Backend fails closed in `NODE_ENV=production` if secrets are insecure or origins wildcarded.
- [x] Automated test suite (**171 tests across 13 suites**) passes cleanly.

---

## 10. Untested Hosting Platform Assumptions & Operational Risks

The following platform-specific assumptions must be monitored during initial deployment:

1. **Neon Serverless Wake-up Latency**:
   - Neon serverless compute branches suspend when inactive to conserve resources.
   - Waking suspended compute during a cold connection takes between 500 ms to 2,000 ms.
   - If initial connection times out, consider increasing `connectionTimeoutMillis` in `packages/server/src/db.ts` or using Neon's connection pooler URL (PgBouncer on port 6543).
2. **Render Persistent Disk Single-Instance Constraint**:
   - Render Persistent Disks cannot be shared across multiple web service containers.
   - In Render Dashboard, ensure **Instance Count is set to 1**. (Scaling horizontally beyond 1 instance would violate disk mounting and split in-memory room documents without Redis pub/sub).
3. **Render WebSocket Proxy Idle Timeout**:
   - Render proxies terminate idle connections after ~100 seconds of silence.
   - Converge's built-in 30-second heartbeat (`PING_INTERVAL_MS = 30000` in `packages/server/src/room.ts`) keeps connections active, but proxy logs should be verified for unexpected disconnects.
4. **Vercel Preview Deployments vs ALLOWED_ORIGINS**:
   - Vercel automatically deploys preview URLs for feature branches (e.g. `https://crdt-editor-core-git-feat.vercel.app`).
   - If `ALLOWED_ORIGINS` on Render only lists the production URL (`https://crdt-editor-core.vercel.app`), preview branch connections will be rejected with `4008 POLICY_VIOLATION`.
   - Test preview branches by temporarily adding their URLs to `ALLOWED_ORIGINS` or using production builds.
