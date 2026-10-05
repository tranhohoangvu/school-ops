# Deployment Architecture

## 1. Production Hosting & Runtime Model

The production deployment of **SchoolOps** is partitioned into three decoupled tiers on **Vercel** and **Neon**:
1. **Frontend Tier**: Next.js 16 App Router application deployed on **Vercel** with edge caching and static asset distribution.
2. **Backend Tier**: Node.js + Express + TypeScript REST API deployed on **Vercel Serverless Functions** via `backend/vercel.json` and `backend/api/index.js`.
3. **Database Tier**: Cloud-native **Neon Serverless PostgreSQL** database with connection pooling and automated scaling.

```mermaid
graph TD
    subgraph Client ["Client Device (Browser)"]
        BrowserApp["React 19 SPA (Next.js 16)"]
    end

    subgraph VercelPlatform ["Vercel Cloud Platform"]
        subgraph FrontendApp ["Frontend (Next.js 16 App Router)"]
            NextEdge["Vercel Edge Network / Global CDN"]
            NextConfig["API Proxy / Rewrites (/api/*, /health)"]
        end

        subgraph BackendServerless ["Backend (Vercel Serverless Function)"]
            ServerlessHandler["Serverless Entrypoint: backend/api/index.js"]
            ExpressApp["Express Application (dist/app.js)"]
            AuthMiddleware["JWT Authentication & Dynamic RBAC"]
            Controllers["Controllers & Zod Validators"]
            Services["Business Domain Logic & Invariants"]
            HealthCheck["GET /health"]
        end
    end

    subgraph DatabaseTier ["Database Tier (Neon Serverless PostgreSQL)"]
        NeonPooler["Neon Connection Pooler (PgBouncer)"]
        PgDatabase[("PostgreSQL 16 Engine<br/>12 Normalized Tables, Triggers, Constraints")]
    end

    BrowserApp -->|"HTTPS Requests"| NextEdge
    NextEdge -->|"Internal / External API Route"| NextConfig
    NextConfig -->|"REST API / JSON<br/>(Bearer Token / Cookie)"| ServerlessHandler
    ServerlessHandler --> ExpressApp
    ExpressApp --> AuthMiddleware
    AuthMiddleware --> Controllers
    Controllers --> Services
    Services -->|"Parameterized SQL (pg.Pool with SSL)"| NeonPooler
    NeonPooler --> PgDatabase
    ExpressApp -.-> HealthCheck
```

---

## 2. Vercel Serverless Function Deployment (Express Backend)

The Express REST API is adapted for Vercel Serverless Functions using the root wrapper `backend/api/index.js` and custom routing instructions in `backend/vercel.json`.

### 2.1. Serverless Routing Configuration (`backend/vercel.json`)
```json
{
  "version": 2,
  "buildCommand": "npm run build",
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/api/index.js"
    }
  ]
}
```

### 2.2. Serverless Function Handler (`backend/api/index.js`)
```javascript
const { app } = require('../dist/app.js');

module.exports = app;
```
* During build time on Vercel, `npm run build` runs `tsc` to compile TypeScript source into `backend/dist/`.
* Incoming HTTP requests matching any route (`/(.*)`) are routed to `backend/api/index.js`, which exports the initialized Express instance as the serverless request listener.

### 2.3. Backend Environment Variables on Vercel
| Variable | Example / Purpose | Secret? |
| :--- | :--- | :---: |
| `NODE_ENV` | `production` | No |
| `DATABASE_URL` | Neon pooled connection string (`postgresql://user:pass@ep-xyz-pooler.region.neon.tech/neondb?sslmode=require`) | Yes |
| `JWT_SECRET` | 32+ character random secret for signing JWT tokens | Yes |
| `JWT_EXPIRES_IN` | `7d` | No |
| `CORS_ORIGIN` | Allowed production frontend URL (e.g. `https://schoolops.vercel.app`) | No |

---

## 3. Neon Serverless PostgreSQL (Database Tier)

### 3.1. Provisioning & Connection Pooling
- **Engine**: Cloud-native PostgreSQL 16+.
- **Serverless Architecture**: Instant compute branching, autoscaling, and scale-to-zero when idle.
- **Connection Mode**: For serverless functions on Vercel, utilize **Neon's pooled connection string** (`-pooler` endpoint powered by PgBouncer) to prevent connection exhaustion during concurrent invocations:
  ```env
  DATABASE_URL="postgresql://user:password@ep-xyz-pooler.ap-southeast-1.aws.neon.tech/school_ops?sslmode=require"
  ```
- **SSL Enforcement**: Automated in `backend/src/config/database.ts`:
  ```typescript
  const requiresSsl = isProduction || 
    ENV.DATABASE_URL.includes('neon.tech') || 
    ENV.DATABASE_URL.includes('render.com') || 
    ENV.DATABASE_URL.includes('supabase.co');

  export const pool = new Pool({
    connectionString: ENV.DATABASE_URL,
    ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  ```

### 3.2. Migration Execution
Database migrations are versioned under `backend/migrations/` and executed sequentially against the Neon database:
```bash
# Execute migrations against Neon PostgreSQL (from local or CI/CD terminal)
DATABASE_URL="postgresql://user:password@ep-xyz.region.neon.tech/school_ops?sslmode=require" npm run migrate
```
Migration sequence:
1. `001_initial_schema.sql` (12 normalized tables: users, classes, students, desks, seats, attendance...)
2. `002_constraints.sql` (Unique keys, check constraints, capacity bounds)
3. `003_indexes.sql` (Query acceleration indexes on foreign keys and lookups)
4. `004_functions.sql` (Stored procedures & capacity validators)
5. `005_triggers.sql` (Auto timestamp triggers and class capacity enforcement)
6. `006_seed.sql` (Deterministic seed dataset with bcrypt hashed accounts)
7. `007_timetable_rules.sql` (Consecutive period constraints and room conflict index)

---

## 4. Frontend Configuration & Next.js Rewrites on Vercel

### 4.1. TailwindCSS v4 Native Dependencies (`frontend/vercel.json`)
TailwindCSS v4 uses binary packages (`@tailwindcss/oxide` and `lightningcss`). To guarantee seamless deployment on Vercel's Linux build environment:
```json
{
  "installCommand": "npm install && npm install --no-save @tailwindcss/oxide-linux-x64-gnu lightningcss-linux-x64-gnu"
}
```

### 4.2. Local & Production Rewrites (`next.config.ts`)
Next.js acts as an API gateway, proxying `/api/*` and `/health` requests to the Express backend without CORS issues:
```typescript
const nextConfig: NextConfig = {
  async rewrites() {
    const backendUrl = getBackendUrl(); // Reads BACKEND_INTERNAL_URL or NEXT_PUBLIC_API_URL

    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/health",
        destination: `${backendUrl}/health`,
      },
    ];
  },
};
```

### 4.3. Frontend Environment Variables on Vercel
| Variable | Value / Description | Secret? |
| :--- | :--- | :---: |
| `NEXT_PUBLIC_API_URL` | Production URL of the backend Vercel project (e.g. `https://schoolops-api.vercel.app`) | No |

---

## 5. Health Monitoring & Serverless Readiness

The backend provides a dedicated health check endpoint:
- **Endpoint**: `GET /health`
- **Behavior**: Executes a lightweight `SELECT 1` query to verify Neon PostgreSQL connectivity and connection pool health.
- **Success Response**: `HTTP 200 OK`
  ```json
  {
    "status": "ok",
    "database": "connected",
    "timestamp": "2026-10-05T13:45:00.000Z"
  }
  ```
- **Failure Response**: `HTTP 503 Service Unavailable` if database connectivity drops.
