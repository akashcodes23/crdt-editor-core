# Converge: Production Deployment Checklist

**Role**: Staff Platform & DevOps Engineer  
**Scope**: Actionable, step-by-step runbook for deploying Converge to Render and Vercel.  
**Rule**: Distinguishes codebase implementation from hosting dashboard configuration.

---

## Part A: Codebase Preparation (Already Completed in Repository)

The following changes have already been implemented, verified, and regression-tested in the codebase:
- [x] **Dynamic Port & Host Binding**: Server reads `process.env.PORT` and binds to `0.0.0.0` (`packages/server/src/index.ts`).
- [x] **Single-Port HTTP & WebSocket Ingress**: Express and `WebSocketServer` share the same `http.Server` instance.
- [x] **Dynamic Cloud Database SSL**: Added `DATABASE_SSL=true` and `DATABASE_SSL_REJECT_UNAUTHORIZED` support (`packages/server/src/db.ts`).
- [x] **Client HTTP API & Token Resolution**: `HistoryPane` and `useYDoc` dynamically derive HTTPS endpoint from `NEXT_PUBLIC_WS_URL` and transmit bearer tokens (`packages/client/src/lib/yjs.ts`).
- [x] **Persistent Disk Path Support**: `LEVELDB_DIR` allows pointing to mounted storage volumes (`packages/server/src/persistence.ts`).
- [x] **Fail-Closed Security Configuration**: Server refuses to start in `NODE_ENV=production` if `CONVERGE_AUTH_SECRET`, `ADMIN_API_KEY`, or `ALLOWED_ORIGINS` are insecure or wildcarded.
- [x] **Quality Gates Clean**: 171 automated tests passing across 13 suites; production build verified.

---

## Part B: Pre-Deployment Secrets & Token Generation

Run these commands locally on your machine before configuring the hosting dashboards:

```bash
# 1. Generate Server Capability Signing Secret (CONVERGE_AUTH_SECRET)
openssl rand -hex 32

# 2. Generate Server Administrative API Key (ADMIN_API_KEY)
openssl rand -hex 32
```

### 3. Generate Public Demo Capability Token
To generate a valid visitor token for `NEXT_PUBLIC_CONVERGE_TOKEN`:
From `packages/server` in your local terminal:
```bash
node -e "
const crypto = require('crypto');
const secret = 'YOUR_GENERATED_CONVERGE_AUTH_SECRET_HERE';
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
console.log(b64 + '.' + sig);
"
```
Save this token output for the Vercel dashboard.

---

## Part C: Database Provisioning (Neon Managed PostgreSQL)

1. **Provision Neon Serverless PostgreSQL 15+**:
   - Navigate to [Neon](https://neon.tech) $\to$ **Create Project**.
   - **Project Name**: `converge-core`
   - **Postgres Version**: `15` or `16`
   - **Region**: Choose region closest to your Render service (e.g. `AWS us-east-2`).
   - Copy the connection string under **Connection Details**:
     ```
     postgresql://<user>:<password>@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require
     ```
2. **TLS Verification Note**:
   - Neon provides valid DigiCert/Let's Encrypt certificates.
   - Converge automatically verifies the certificate chain (`rejectUnauthorized: true`).
   - Do **NOT** set `DATABASE_SSL_REJECT_UNAUTHORIZED=false` in production.
3. **Schema Migration Note**:
   - No manual SQL scripts need to be run.
   - Converge automatically initializes tables (`operations`, `doc_snapshots`, `durable_acks`) on first boot.

---

## Part D: Backend Web Service Setup (Render)

1. In Render Dashboard $\to$ **New +** $\to$ **Web Service**.
2. Connect your GitHub repository: `akashcodes23/crdt-editor-core`.
3. Configure Service Settings:
   - **Name**: `converge-server` (or your chosen name)
   - **Region**: Same region as your PostgreSQL instance.
   - **Branch**: `main`
   - **Root Directory**: `.` (leave at repository root)
   - **Runtime**: `Node`
   - **Build Command**: `pnpm --filter server build`
   - **Start Command**: `pnpm --filter server start`
   - **Instance Type**: **Starter** (\$7/mo) — *Required for persistent WebSockets and disk attachment*.
4. **Attach Persistent Disk**:
   - Under service settings, navigate to **Disks** $\to$ **Add Disk**.
   - **Name**: `converge-leveldb-data`
   - **Mount Path**: `/data`
   - **Size**: `1 GB`
5. **Configure Environment Variables**:
   Add the following under **Environment**:

   | Key | Value | Notes |
   | :--- | :--- | :--- |
   | `NODE_ENV` | `production` | Enforces fail-closed security checks |
   | `DATABASE_URL` | `postgresql://...` | Neon connection string with `?sslmode=require` |
   | `DATABASE_SSL` | `true` | Optional (auto-detected via Neon URL) |
   | `LEVELDB_DIR` | `/data/leveldb` | Path inside attached persistent disk |
   | `CONVERGE_AUTH_SECRET` | *`<Your 64-char hex secret from Part B.1>`* | Server signing secret (keep confidential) |
   | `ADMIN_API_KEY` | *`<Your 64-char hex secret from Part B.2>`* | Admin snapshot/compaction key (keep confidential) |
   | `ALLOWED_ORIGINS` | `https://<your-vercel-app>.vercel.app` | Set initial placeholder; update after Part E |

   > [!NOTE]
   > **Do NOT add `PORT` to Environment Variables**. Render automatically provisions and sets `PORT=10000` inside the container. Leaving `PORT` empty or setting an invalid port will cause a startup validation failure. Converge automatically binds to `0.0.0.0:${PORT}`.

6. **Configure Health Check**:
   - Under **Health Check Path**, enter: `/health`
7. Click **Create Web Service**.
8. Note your public backend URL: `https://<converge-server>.onrender.com`.

---

## Part E: Frontend Static Deployment (Vercel)

> [!IMPORTANT]
> **Build-Time Inlining**: Next.js inlines all `NEXT_PUBLIC_*` variables into the static JavaScript bundles during build time.
> - Never store server-side secrets in `NEXT_PUBLIC_*` variables.
> - Updating an environment variable in the Vercel dashboard requires clicking **Redeploy** to rebuild the application with the new value.

1. In Vercel Dashboard $\to$ **Add New...** $\to$ **Project**.
2. Import repository `akashcodes23/crdt-editor-core`.
3. Configure Project Settings:
   - **Framework Preset**: `Next.js`
   - **Root Directory**: Click edit and select `packages/client`.
   - **Build Command**: Override to `pnpm --filter client build` (or leave default `next build`).
   - **Output Directory**: Leave default (`.next`).
   - **Install Command**: Leave default (`pnpm install`).
4. **Configure Environment Variables**:
   Add the following variables under **Environment Variables**:

   | Key | Value | Notes |
   | :--- | :--- | :--- |
   | `NEXT_PUBLIC_WS_URL` | `wss://<converge-server>.onrender.com` | Backend URL from Part D with `wss://` |
   | `NEXT_PUBLIC_HTTP_API_URL` | `https://<converge-server>.onrender.com` | Backend URL from Part D with `https://` |
   | `NEXT_PUBLIC_ROOM_NAME` | `demo` | Default room name |
   | `NEXT_PUBLIC_CONVERGE_TOKEN` | *`<Generated token from Part B.3>`* | Scoped demo token (sub: portfolio-visitor, room: demo) |
5. Click **Deploy**.
6. When deployment finishes, copy your assigned Vercel URL: `https://<your-project>.vercel.app`.

---

## Part F: Close the Security Loop (Update ALLOWED_ORIGINS)

1. Return to the **Render Dashboard** $\to$ **converge-server** $\to$ **Environment**.
2. Update `ALLOWED_ORIGINS` with your exact Vercel production domain:
   ```
   ALLOWED_ORIGINS=https://<your-project>.vercel.app
   ```
   *(If you also have a custom domain or preview domains, add them comma-separated)*.
3. Save changes. Render will perform an automated zero-downtime rolling restart.

---

## Part G: Post-Deployment Verification Smoke Tests

Execute these verification checks against the live production URLs:

- [ ] **1. Backend Health Check**:
  ```bash
  curl -i https://<converge-server>.onrender.com/health
  ```
  *Expected*: HTTP 200 OK with `{"status":"ok","database":"healthy"}`.
- [ ] **2. Origin Rejection Test**:
  ```bash
  curl -i -H "Origin: https://malicious-site.com" https://<converge-server>.onrender.com/health
  ```
  *Expected*: Handshake or CORS policy error.
- [ ] **3. Admin Route Protection**:
  ```bash
  curl -i -X POST https://<converge-server>.onrender.com/doc/demo/snapshot
  ```
  *Expected*: HTTP 401 Unauthorized (`{"error":"UNAUTHORIZED"}`).
- [ ] **4. End-to-End Collaborative Session**:
  1. Open `https://<your-project>.vercel.app` in Chrome.
  2. Open an Incognito window to `https://<your-project>.vercel.app`.
  3. Verify status badges report `✓ Connected` and `✓ Saved`.
  4. Type in Window 1 and observe character-by-character sync in Window 2.
  5. Click `⏱️ View Time-Travel History` to ensure the HTTPS API successfully loads previous operations.
- [ ] **5. Restart Recovery Check**:
  1. Trigger a manual restart on Render.
  2. Refresh the frontend page.
  3. Verify that all previously typed code is preserved and restored from PostgreSQL and LevelDB.

---

## Part H: Rollback Runbook

* **Frontend Failure**:
  - In Vercel $\to$ **Deployments** $\to$ click `...` next to prior build $\to$ **Instant Rollback**.
* **Backend Failure**:
  - In Render $\to$ **Events** $\to$ select previous deployment $\to$ **Rollback to this deploy**.
* **Database State Reset (Emergency Only)**:
  - Connect to PostgreSQL via psql:
    `TRUNCATE TABLE operations, doc_snapshots, durable_acks;`
  - Flush LevelDB cache: restart service after clearing `/data/leveldb`.
