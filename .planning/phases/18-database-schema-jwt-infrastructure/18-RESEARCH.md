# Phase 18: Database Schema & JWT Infrastructure — Research

**Researched:** 2026-04-09
**Domain:** Prisma schema migration, JWT infrastructure (jose), NestJS DI, PostgreSQL CHECK constraints
**Confidence:** HIGH

---

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01:** Do NOT drop and recreate the tenants table. Use `@@map("tenants")` on the `Organization` Prisma model — the DB table stays named `tenants`, the Prisma client becomes `prisma.organization`. Zero-risk rename: no migration SQL needed.

**D-02:** Keep all `tenant_id` field names throughout the existing v1.0 schema for backward compatibility. Add code comment: `// tenantId fields intentionally kept in v1.0 tables — they reference organizations.id (@@map("tenants"))`.

**D-03:** `Organization` model structure: id (UUID PK), name (text), shortId (varchar 20, unique), logo_url (text, nullable), is_active (boolean, default true), created_by_user_id (UUID FK to users.id, nullable), created_at, updated_at.

**D-04:** `generateOrgShortId(name, prisma)` utility at `src/auth/utils/generate-short-id.ts`. First 5 alphanumeric chars + hyphen + zero-padded counter, retry up to 10 times before throwing.

**D-05:** `users` table: id (UUID PK), email (text), auth_provider (text CHECK: 'google'|'magic_link'), organization_id (UUID FK), role (text CHECK: 'owner'|'admin'|'member'|'viewer'), full_name (text, nullable), is_active (boolean, default true), created_at, updated_at. NO password_hash field.

**D-06:** Unique constraint: `(organization_id, email)` on users.

**D-07:** No global email unique constraint — same email allowed across different orgs.

**D-08:** Roles are fixed system-level constants — no `roles` table.

**D-09:** Role values via text CHECK constraint: owner, admin, member, viewer.

**D-10:** owner role set only at org creation; cannot be assigned via invite.

**D-11:** `invitations` table: id, organization_id (FK), email, role (text CHECK: 'admin'|'member'|'viewer'), token (text, unique), status (text CHECK: 'pending'|'accepted'|'expired', default 'pending'), expires_at (timestamptz), invited_by_user_id (FK to users.id), created_at, updated_at.

**D-12:** No unique constraint on (organization_id, email) for invitations.

**D-13:** `token` must be globally unique across all invitations.

**D-14:** Composite index on `(organization_id, email, status)` for invitations.

**D-15:** JWT library: `jose` (NOT @nestjs/jwt, NOT jsonwebtoken). Implement JwtService as plain NestJS injectable.

**D-16:** `src/auth/jwt.service.ts` with `sign(payload, options?)`, `verify(token)`. Throws `UnauthorizedException` on invalid/expired tokens.

**D-17:** JWT payload uses `sub` and `org` (NOT userId/organizationId):

```json
{ "sub": "user-uuid", "org": "org-uuid", "role": "owner|admin|member|viewer", "iat": ..., "exp": ... }
```

**D-18:** `signAccessToken()` (15m) and `signRefreshToken()` (7d) convenience methods.

**D-19:** JWT_SECRET added to: `.env.example`, `src/config/env.ts` (Zod, `.min(32)`), `docker-compose.yml`, any `.env.test`.

**D-20:** Split into two migrations: (1) model rename only (near-empty SQL), (2) add User + Invitation models.

**D-21:** Raw SQL CHECK constraints in migration files (not Prisma schema).

**D-22:** Existing v1.0 data unaffected.

**D-23:** `prisma/seed.ts` must update `prisma.tenant.upsert()` → `prisma.organization.upsert()`.

**D-24:** Org/User creation sequence: (1) Create Organization (created_by_user_id=NULL), (2) Create User (organization_id=new_org_id), (3) UPDATE Organization SET created_by_user_id=new_user_id. Single transaction in Phase 19.

**D-25:** Create `src/auth/auth.module.ts` that exports JwtService.

**D-26:** JwtService not responsible for token refresh, logout invalidation, or refresh token storage.

**D-27:** Unit tests: sign(), verify(), verify() throws on expired, verify() throws on tampered, correct sub/org/role fields.

**D-28:** No integration tests with real endpoints in Phase 18.

### Claude's Discretion

- Migration file naming convention (timestamp prefix standard)
- Exact Prisma model field ordering/grouping style
- `jose` version to pin (latest stable at time of install)

### Deferred Ideas (OUT OF SCOPE)

- Magic Link token generation and email sending (Phase 19/20)
- Google OAuth callback and session handling (Phase 19)
- Refresh token storage table (Phase 22)
- Auth middleware / guards / RBAC guards (Phase 21)
- Email notification when user removed (Phase 20)
- Role change session invalidation strategy (Phase 21/22)
- Owner role transfer
- Actual DB table rename (`tenants` → `organizations`) — deferred post-v2.0

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID      | Description                                                                                                 | Research Support                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| UM-01   | Organization signup endpoint accepts org name, admin email — creates new tenant with auto-generated shortId | D-03/D-04 schema + shortId utility researched                                |
| UM-02   | Organization model: id, name, shortId, created_at, updated_at, created_by_user_id                           | D-03 verified against existing schema                                        |
| UM-03   | Users table: id, email, organization_id (FK), role (text), full_name, is_active, created_at, updated_at     | D-05 researched; auth_provider replaces password_hash per spec/auth-rules.md |
| UM-04   | Unique constraint on (organization_id, email) prevents duplicate user accounts per org                      | D-06 verified; PostgreSQL composite UNIQUE constraint                        |
| AUTH-01 | JWT access token (15m) + refresh token (7d); signed with JWT_SECRET                                         | D-15 through D-19; jose library researched                                   |

</phase_requirements>

---

## Summary

Phase 18 adds three database tables (organizations, users, invitations) and a JWT infrastructure service to the existing v1.0 NestJS/Prisma/PostgreSQL backend. All core decisions are locked in CONTEXT.md — research focuses on verifying the technical implementation path is sound and documenting gotchas.

The primary technical risk is the `jose` library's ESM-only distribution in a CommonJS NestJS project. Research confirms this is solvable: Node.js 22+ (used in Docker containers, via `node:22-alpine` = 22.22.2 as of 2026-04) natively supports `require(esm)` without experimental flags. The existing Jest config already handles one ESM package (`@openrouter/sdk`) via `transformIgnorePatterns` — the same pattern extends cleanly to `jose`.

The Prisma migration split strategy (D-20) is the correct approach: Migration 1 touches zero SQL (model rename only, `@@map` already present), Migration 2 is purely additive. CHECK constraints added as raw SQL appended to the migration file after Prisma generates it — this is the established pattern for constraints Prisma doesn't support natively.

**Primary recommendation:** Install `jose@latest`, extend `transformIgnorePatterns` to include `jose`, use `SignJWT`/`jwtVerify` with `TextEncoder` for the HMAC secret. The plan tasks already in `18-01-PLAN.md` are correct in structure but contain a payload field mismatch (`userId`/`organizationId` vs locked D-17 `sub`/`org`) that must be corrected before execution.

---

## Standard Stack

### Core

| Library        | Version | Purpose                      | Why Standard                                                                                      |
| -------------- | ------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| jose           | 6.2.2   | JWT sign/verify (HS256)      | ESM-native, zero deps, actively maintained; chosen over jsonwebtoken which is in maintenance mode |
| Prisma 7       | ^7.0.0  | ORM + migrations             | Already installed, locked by CLAUDE.md                                                            |
| @nestjs/config | ^4.0.3  | ConfigService for JWT_SECRET | Already installed, used for all env validation                                                    |
| zod            | ^4.3.6  | Env schema validation        | Already installed, used in `src/config/env.ts`                                                    |

[VERIFIED: npm registry] — jose@6.2.2 is the current latest version as of 2026-04-09.
[VERIFIED: codebase] — Prisma 7, @nestjs/config, zod all already in package.json.

### Supporting

| Library         | Version | Purpose                    | When to Use     |
| --------------- | ------- | -------------------------- | --------------- |
| @nestjs/testing | ^11.0.1 | Test module for JwtService | Unit tests only |

### Alternatives Considered

| Instead of | Could Use    | Tradeoff                                                                                     |
| ---------- | ------------ | -------------------------------------------------------------------------------------------- |
| jose       | jsonwebtoken | jsonwebtoken is in maintenance mode; synchronous API (no async/await); CJS native but legacy |
| jose       | @nestjs/jwt  | @nestjs/jwt wraps jsonwebtoken; adds abstraction layer with no benefit for this use case     |

**Installation:**

```bash
npm install jose
```

**Version verification:** [VERIFIED: npm registry] `npm view jose version` → `6.2.2`

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── auth/
│   ├── auth.module.ts           # Exports JwtService (D-25)
│   ├── jwt.service.ts           # sign(), verify(), signAccessToken(), signRefreshToken()
│   ├── jwt.service.spec.ts      # Unit tests (D-27)
│   └── utils/
│       └── generate-short-id.ts # generateOrgShortId() utility (D-04)
├── config/
│   └── env.ts                   # Extend with JWT_SECRET validation (D-19)
prisma/
├── schema.prisma                # Add Organization, User, Invitation models
├── seed.ts                      # Update prisma.tenant → prisma.organization (D-23)
└── migrations/
    ├── [ts]_rename_tenant_to_organization/  # Migration 1: near-empty (D-20)
    └── [ts]_add_user_invitation_tables/     # Migration 2: additive only (D-20)
```

### Pattern 1: jose SignJWT with HMAC Secret

`jose` requires the HMAC secret to be a `Uint8Array` (from `TextEncoder`), not a plain string. This is different from `jsonwebtoken`'s string secret.

```typescript
// Source: jose official docs (github.com/panva/jose)
import { SignJWT, jwtVerify } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET);

// Sign
const token = await new SignJWT({ sub: userId, org: orgId, role })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(secret);

// Verify
const { payload } = await jwtVerify(token, secret);
```

[CITED: https://github.com/panva/jose — SignJWT API]

**Key difference from jsonwebtoken:** All operations are `async` (return Promises). The `sign()` and `verify()` methods on JwtService must also be `async` — this is a breaking change from the synchronous jsonwebtoken API. The `18-01-PLAN.md` Task 3 uses synchronous signatures (`sign(): string`, `verify(): JwtPayload`) which must be corrected to `Promise<string>` and `Promise<JwtPayload>`.

### Pattern 2: JwtService as NestJS Injectable

```typescript
// Source: established NestJS DI pattern [ASSUMED based on existing codebase patterns]
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';

export interface JwtPayload {
  sub: string; // user UUID
  org: string; // organization UUID
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

@Injectable()
export class JwtService {
  private readonly secret: Uint8Array;

  constructor(private configService: ConfigService) {
    const raw = this.configService.getOrThrow<string>('JWT_SECRET');
    this.secret = new TextEncoder().encode(raw);
  }

  async sign(payload: JwtPayload, expiresIn = '15m'): Promise<string> {
    return new SignJWT(payload as Record<string, unknown>)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(this.secret);
  }

  async verify(token: string): Promise<JwtPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      return payload as unknown as JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  signAccessToken(payload: JwtPayload): Promise<string> {
    return this.sign(payload, '15m');
  }

  signRefreshToken(payload: JwtPayload): Promise<string> {
    return this.sign(payload, '7d');
  }
}
```

### Pattern 3: Prisma Model Rename with @@map (Zero-SQL Migration)

The existing `Tenant` model already has `@@map("tenants")`. Renaming the Prisma model to `Organization` while keeping `@@map("tenants")` generates an empty or near-empty migration (Prisma may emit a comment-only file). The DB table name does not change.

**What Prisma generates for Migration 1:**

```sql
-- This is an empty migration (Prisma model rename with @@map intact)
-- The underlying table name "tenants" is unchanged
```

[VERIFIED: codebase] — `@@map("tenants")` already present on the `Tenant` model in `prisma/schema.prisma` line 27.

**All downstream models** (Job, Candidate, Application, etc.) have `Tenant @relation(...)` — these relation references must update from `Tenant` → `Organization` in schema.prisma. The column names (`tenant_id`) remain unchanged.

### Pattern 4: Raw SQL CHECK Constraints in Prisma Migrations

Prisma does not support `CHECK` constraints natively. The pattern is: generate the migration file, then append raw SQL before applying.

```sql
-- Appended after Prisma-generated CREATE TABLE statements:
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_check"
    CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  ADD CONSTRAINT "users_auth_provider_check"
    CHECK (auth_provider IN ('google', 'magic_link'));

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_role_check"
    CHECK (role IN ('admin', 'member', 'viewer')),
  ADD CONSTRAINT "invitations_status_check"
    CHECK (status IN ('pending', 'accepted', 'expired'));
```

[VERIFIED: codebase] — Existing migrations (`20260405120723_init/migration.sql`) use PostgreSQL-style quoted identifiers and CONSTRAINT syntax. This project uses `TIMESTAMPTZ` for timestamps — match that pattern for `expires_at`.

### Pattern 5: shortId Generation Utility

```typescript
// src/auth/utils/generate-short-id.ts [ASSUMED pattern based on D-04 spec]
export async function generateOrgShortId(name: string, prisma: PrismaService): Promise<string> {
  const prefix = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 5)
    .padEnd(5, 'x'); // pad if name < 5 alphanumeric chars

  for (let i = 1; i <= 10; i++) {
    const shortId = `${prefix}-${String(i).padStart(2, '0')}`;
    const existing = await prisma.organization.findUnique({
      where: { shortId },
      select: { id: true },
    });
    if (!existing) return shortId;
  }
  throw new Error(`Could not generate unique shortId for org: ${name}`);
}
```

### Anti-Patterns to Avoid

- **Synchronous JWT operations:** `jose` is async-only. Do not use `.sign()` without `await`. The existing `18-01-PLAN.md` Task 3 shows synchronous `sign(): string` — this is wrong for `jose` and must be corrected.
- **Payload field naming mismatch:** The existing plan Task 3 uses `userId`/`organizationId` in the payload interface. The locked decision D-17 requires `sub`/`org`. Any test stubs that assert on `payload.userId` must be changed to `payload.sub`.
- **String JWT secret with jose:** `jose` requires `Uint8Array`. `new TextEncoder().encode(secret)` is mandatory.
- **Single migration for rename + new tables:** D-20 requires split migrations. Running both in one migration risks losing the clean validation of the rename step.
- **ENUMs instead of text + CHECK:** CLAUDE.md forbids PostgreSQL ENUMs. Use text fields with CHECK constraints only.

---

## Don't Hand-Roll

| Problem          | Don't Build                              | Use Instead                          | Why                                                          |
| ---------------- | ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| JWT signing      | Custom HMAC implementation               | `jose` SignJWT                       | Correct JWA implementation, handles alg header, iat/exp      |
| JWT verification | Manual base64 decode + signature check   | `jose` jwtVerify                     | Handles clock skew, expiry, algorithm verification           |
| Secret encoding  | String comparison of JWT secret          | `TextEncoder().encode()` then `jose` | jose requires Uint8Array; string comparison is timing-unsafe |
| Env validation   | Manual process.env checks in constructor | Zod schema in `src/config/env.ts`    | Already the established pattern; fail-fast at startup        |
| Unique shortId   | Probabilistic UUID suffix                | Deterministic prefix + counter loop  | Readable, predictable, collision-safe with retry             |

---

## ESM / CJS Compatibility — jose in This Project

This is the highest-risk technical area. Full findings:

### Runtime (Node.js)

| Environment       | Node Version                           | require(esm) support     | Status   |
| ----------------- | -------------------------------------- | ------------------------ | -------- |
| Local dev         | 25.8.1                                 | Native (no flags needed) | No issue |
| Docker containers | 22.22.2 (node:22-alpine as of 2026-04) | Native (>= 22.12.0)      | No issue |

[VERIFIED: codebase] — `node --version` returns `v25.8.1` locally. [VERIFIED: WebSearch] — `node:22-alpine` resolves to 22.22.2 as of 2026-04.

**Conclusion:** At runtime, `import { SignJWT } from 'jose'` works in the compiled TypeScript output. No `NODE_OPTIONS` flag needed.

### Jest / ts-jest

Jest uses `transformIgnorePatterns` to decide which `node_modules` to transpile. The project already has:

```json
"transformIgnorePatterns": ["node_modules/(?!@openrouter)"]
```

This must be extended to include `jose`:

```json
"transformIgnorePatterns": ["node_modules/(?!@openrouter|jose)"]
```

[VERIFIED: codebase] — Jest config in `package.json` (not a standalone file). Pattern confirmed.

**Why this works:** ts-jest will transpile the `jose` ESM module for the Jest environment, avoiding the `ERR_REQUIRE_ESM` error that would otherwise occur since Jest runs in a CommonJS context.

### TypeScript Compilation

`tsconfig.json` uses `"module": "nodenext"` and `"moduleResolution": "nodenext"`. This means TypeScript resolves packages using the `exports` field in `package.json`. The `jose` package exports correctly for both ESM and CJS contexts under Node.js 22+.

[ASSUMED] — TypeScript compilation of `import { SignJWT } from 'jose'` should work without issues under `nodenext` resolution, as `jose` ships proper type declarations and exports map.

---

## Common Pitfalls

### Pitfall 1: Async JWT operations breaking existing sync call sites

**What goes wrong:** `jose`'s `SignJWT.sign()` and `jwtVerify()` are async. If Phase 21 guard code calls `jwtService.verify()` without `await`, it will get a Promise instead of the payload — no runtime error, silent failure.

**Why it happens:** Callers written with `jsonwebtoken` in mind expect `verify()` to be synchronous.

**How to avoid:** JwtService method signatures must use `async` and `Promise<T>` return types. Phase 21 guards must `await` the call.

**Warning signs:** A guard that passes with `undefined` user payload (no TypeScript error if types are loose).

### Pitfall 2: JWT payload field name mismatch (sub/org vs userId/organizationId)

**What goes wrong:** The existing `18-01-PLAN.md` Task 3 code sample uses `userId`/`organizationId` in `JwtPayload` and the JWT payload comment. D-17 locks `sub`/`org`. Any code or tests using `payload.userId` will be silently wrong — the field will be undefined at runtime because `jose` standard claims use `sub`.

**Why it happens:** The plan was written before D-17 was locked.

**How to avoid:** The `JwtPayload` interface must define `sub: string; org: string; role: ...`. All test assertions must check `payload.sub` not `payload.userId`.

**Warning signs:** `payload.userId === undefined` at runtime in Phase 21 guards.

### Pitfall 3: Migration 1 generating unexpected SQL (Prisma Tenant → Organization rename)

**What goes wrong:** Prisma's migration engine might generate `ALTER TABLE "tenants" RENAME TO "organizations"` when renaming the Prisma model, even though `@@map("tenants")` is present — depending on whether Prisma compares against the current migration state or the DB state.

**Why it happens:** Prisma's model rename detection is sometimes confused by `@@map` changes if the previous migration already had `@@map("tenants")` on the `Tenant` model.

**How to avoid:** After running `npx prisma migrate dev --name rename_tenant_to_organization`, **inspect the generated SQL before applying**. If it contains any `RENAME TO` or `DROP TABLE`, abort and use `--create-only` flag. The expected SQL for Migration 1 is empty or contains only comments.

**Warning signs:** Migration file contains `RENAME TABLE` or `DROP TABLE tenants`.

### Pitfall 4: seed.ts compile error after Prisma model rename

**What goes wrong:** `prisma/seed.ts` calls `prisma.tenant.upsert()` at line 91. After the Prisma client is regenerated with the renamed `Organization` model, this breaks at TypeScript compile time (or at `ts-node` runtime).

**Why it happens:** `prisma.tenant` no longer exists on the PrismaClient type after the rename.

**How to avoid:** D-23 is explicit — update `prisma.tenant.upsert()` → `prisma.organization.upsert()` and update the `name: 'Triolla'` call to also set any new required fields (Organization now requires `shortId`). This must happen in the same task as Migration 1.

**Warning signs:** `npm run db:seed` fails with `TypeError: Cannot read properties of undefined (reading 'upsert')`.

### Pitfall 5: Organization requires shortId but seed creates it without one

**What goes wrong:** The new `Organization` model requires `shortId` (not nullable). The existing seed creates `{ id: TENANT_ID, name: 'Triolla' }` without a shortId. After schema migration, the seed will fail with a NOT NULL constraint violation.

**Why it happens:** The seed pre-dates the shortId field.

**How to avoid:** Update the seed upsert to include `shortId: 'triol-01'` as a hardcoded dev value.

### Pitfall 6: docker-compose.yml missing JWT_SECRET — silent failure

**What goes wrong:** The Docker containers use `env_file: .env` for all env vars. The `environment:` block in `docker-compose.yml` only has `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`. If `JWT_SECRET` is only in `.env.example` but not in the actual `.env` file, the Zod validation at startup will throw and the container will refuse to start.

**Why it happens:** D-19 requires JWT_SECRET in `.env.example` and env.ts — but the developer must also add it to their local `.env` file.

**How to avoid:** The plan must include a task to add `JWT_SECRET=<generate hint>` to `.env.example`, and document that the developer must add it to `.env` before running docker. Optionally add it as a non-secret comment to `docker-compose.dev.yml` `environment:` block for clarity (it will be overridden by `.env`).

### Pitfall 7: Prisma circular FK during schema validation

**What goes wrong:** `Organization` has `createdByUser User? @relation(...)` (FK to users.id), and `User` has `organization Organization @relation(...)` (FK to organizations.id). Prisma may complain about ambiguous relations when two models reference each other.

**Why it happens:** Bi-directional relations with nullable FK need explicit relation naming in Prisma.

**How to avoid:** Use named relations in Prisma schema:

```prisma
model Organization {
  createdByUser  User? @relation("OrgCreatedBy", fields: [createdByUserId], references: [id])
  users          User[] @relation("OrgUsers")
}
model User {
  organization   Organization @relation("OrgUsers", fields: [organizationId], references: [id])
  createdOrgs    Organization[] @relation("OrgCreatedBy")
}
```

[ASSUMED — standard Prisma pattern for self-referential and cross-referential relations]

---

## Code Examples

### JwtPayload type (correct — D-17)

```typescript
// src/auth/jwt.service.ts
export interface JwtPayload {
  sub: string; // user UUID (standard JWT "subject" claim)
  org: string; // organization UUID
  role: 'owner' | 'admin' | 'member' | 'viewer';
}
```

### JwtService unit test skeleton (correct payload field names)

```typescript
// src/auth/jwt.service.spec.ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from './jwt.service';
import { UnauthorizedException } from '@nestjs/common';

describe('JwtService', () => {
  let jwtService: JwtService;
  const JWT_SECRET = 'test-secret-key-for-unit-tests-must-be-32-chars';

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        JwtService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              if (key === 'JWT_SECRET') return JWT_SECRET;
              throw new Error(`Unknown config key: ${key}`);
            },
          },
        },
      ],
    }).compile();
    jwtService = module.get<JwtService>(JwtService);
  });

  it('sign() returns a JWT string', async () => {
    const payload = { sub: 'user-1', org: 'org-1', role: 'owner' as const };
    const token = await jwtService.sign(payload);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('verify() decodes correct sub/org/role fields', async () => {
    const payload = { sub: 'user-1', org: 'org-1', role: 'admin' as const };
    const token = await jwtService.sign(payload);
    const decoded = await jwtService.verify(token);
    expect(decoded.sub).toBe('user-1'); // NOT payload.userId
    expect(decoded.org).toBe('org-1'); // NOT payload.organizationId
    expect(decoded.role).toBe('admin');
  });

  it('verify() throws UnauthorizedException on expired token', async () => {
    const token = await jwtService.sign({ sub: 'x', org: 'y', role: 'viewer' }, '-1s');
    await expect(jwtService.verify(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verify() throws UnauthorizedException on tampered token', async () => {
    const token = await jwtService.sign({ sub: 'x', org: 'y', role: 'viewer' });
    const tampered = token.slice(0, -4) + 'XXXX';
    await expect(jwtService.verify(tampered)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('signAccessToken() returns 15m token', async () => {
    const token = await jwtService.signAccessToken({ sub: 'u', org: 'o', role: 'member' });
    expect(typeof token).toBe('string');
  });

  it('signRefreshToken() returns 7d token', async () => {
    const token = await jwtService.signRefreshToken({ sub: 'u', org: 'o', role: 'member' });
    expect(typeof token).toBe('string');
  });
});
```

### Prisma Organization model (with correct relation naming)

```prisma
model Organization {
  id                String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name              String   @db.Text
  shortId           String   @map("short_id") @db.VarChar(20)
  logoUrl           String?  @map("logo_url") @db.Text
  isActive          Boolean  @default(true) @map("is_active")
  createdByUserId   String?  @map("created_by_user_id") @db.Uuid
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime @updatedAt @map("updated_at") @db.Timestamptz

  // tenantId fields intentionally kept in v1.0 tables — they reference organizations.id (@@map("tenants"))
  createdByUser     User?    @relation("OrgCreatedByUser", fields: [createdByUserId], references: [id])
  users             User[]   @relation("OrgUsers")
  invitations       Invitation[]
  // ... v1.0 relations: jobs, candidates, applications, etc.

  @@unique([shortId])
  @@map("tenants")
}
```

---

## Corrections Required to Existing 18-01-PLAN.md

The plan in `18-01-PLAN.md` contains two factual errors that must be corrected before execution:

| #   | Location                               | Error                                               | Correct Value                                                                                          |
| --- | -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| C1  | Task 3 `<behavior>`                    | Tests assert `userId`, `organizationId` in payload  | Must use `sub`, `org` per D-17                                                                         |
| C2  | Task 3 `<action>` JwtPayload interface | `userId: string; organizationId: string`            | `sub: string; org: string`                                                                             |
| C3  | Task 3 `<action>` JwtService code      | `sign(): string` (synchronous)                      | `sign(): Promise<string>` (jose is async)                                                              |
| C4  | Task 3 `<action>` JwtService code      | Uses `jsonwebtoken` (`import * as jwt`)             | Must use `jose` (`import { SignJWT, jwtVerify }`)                                                      |
| C5  | Task 3 `<action>`                      | `JwtPayload` uses `jwt.sign(payload, secret, opts)` | Must use `new SignJWT(payload).setProtectedHeader({alg:'HS256'}).setExpirationTime(opts).sign(secret)` |

---

## Runtime State Inventory

This phase involves a rename/refactor (Tenant → Organization) at the Prisma model level.

| Category            | Items Found                                                                                       | Action Required                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Stored data         | PostgreSQL `tenants` table with TENANT_ID `00000000-0000-0000-0000-000000000001`                  | No rename — `@@map("tenants")` keeps the table name; no data migration needed              |
| Live service config | None — no external services reference the Prisma model name                                       | None                                                                                       |
| OS-registered state | None                                                                                              | None                                                                                       |
| Secrets/env vars    | No existing JWT_SECRET — must be added to `.env` locally and `.env.example`                       | Add JWT_SECRET to `.env` (not committed), `.env.example` (committed)                       |
| Build artifacts     | Prisma generated client (`node_modules/.prisma/client`) will reference `Tenant` until regenerated | `npx prisma generate` after Migration 1 — handled by plan task                             |
| seed.ts             | `prisma.tenant.upsert()` at line 91 — breaks after client regeneration                            | Update to `prisma.organization.upsert()` with `shortId: 'triol-01'` added to create object |

**Key: The actual PostgreSQL table name `tenants` does not change.** Only the Prisma client accessor changes from `prisma.tenant` to `prisma.organization`.

---

## Environment Availability

| Dependency               | Required By                               | Available        | Version                          | Fallback           |
| ------------------------ | ----------------------------------------- | ---------------- | -------------------------------- | ------------------ |
| Node.js                  | Runtime, jose ESM support                 | Yes              | 25.8.1 (local), 22.22.2 (Docker) | —                  |
| PostgreSQL 16            | Prisma migrations                         | Yes (via Docker) | 16-alpine                        | —                  |
| Redis 7                  | Docker compose                            | Yes (via Docker) | 7-alpine                         | —                  |
| Docker                   | `npm run docker:up`, `npm run db:migrate` | Yes              | docker compose v2                | —                  |
| jose (not yet installed) | JWT signing/verification                  | Needs install    | —                                | `npm install jose` |

[VERIFIED: codebase] — Node 25.8.1 local, Node 22.22.2 Docker (from Dockerfile `node:22-alpine`). jose not yet in package.json.

---

## Validation Architecture

### Test Framework

| Property           | Value                                            |
| ------------------ | ------------------------------------------------ |
| Framework          | Jest 29 + ts-jest 29.4.6                         |
| Config file        | `package.json` (jest key)                        |
| Quick run command  | `npm test -- --testPathPattern=jwt.service.spec` |
| Full suite command | `npm test`                                       |

### Phase Requirements → Test Map

| Req ID      | Behavior                                          | Test Type | Automated Command                                | File Exists?     |
| ----------- | ------------------------------------------------- | --------- | ------------------------------------------------ | ---------------- |
| AUTH-01     | JwtService.sign() produces valid 15m token        | unit      | `npm test -- --testPathPattern=jwt.service.spec` | No — Wave 0      |
| AUTH-01     | JwtService.verify() decodes sub/org/role          | unit      | same                                             | No — Wave 0      |
| AUTH-01     | verify() throws UnauthorizedException on expired  | unit      | same                                             | No — Wave 0      |
| AUTH-01     | verify() throws UnauthorizedException on tampered | unit      | same                                             | No — Wave 0      |
| AUTH-01     | signAccessToken() returns token (15m)             | unit      | same                                             | No — Wave 0      |
| AUTH-01     | signRefreshToken() returns token (7d)             | unit      | same                                             | No — Wave 0      |
| UM-02/UM-03 | Prisma migration applies without error            | smoke     | `npm run db:migrate` inside Docker               | No — run as task |
| UM-02/UM-03 | Existing v1.0 data intact after migration         | smoke     | DB row count check via SQL                       | No — run as task |

### Sampling Rate

- **Per task commit:** `npm test -- --testPathPattern=jwt.service.spec --passWithNoTests=false`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `src/auth/jwt.service.spec.ts` — covers all 6 AUTH-01 behaviors
- [ ] `src/auth/jwt.service.ts` — the service itself (stub acceptable at Wave 0)
- [ ] `src/auth/auth.module.ts` — NestJS module stub
- [ ] `src/auth/utils/generate-short-id.ts` — utility stub

_(No test framework install needed — Jest + ts-jest already installed.)_

### Jest Config Change Required

The `transformIgnorePatterns` in `package.json` must be updated before jose tests will pass:

```json
"transformIgnorePatterns": ["node_modules/(?!@openrouter|jose)"]
```

[VERIFIED: codebase] — Current value is `"node_modules/(?!@openrouter)"`. This is required before any jose import will work in Jest tests.

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category         | Applies                            | Standard Control                                                         |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| V2 Authentication     | Partial (infrastructure only)      | JWT_SECRET min 32 chars, Zod fail-fast validation                        |
| V3 Session Management | No (tokens not stored in Phase 18) | —                                                                        |
| V4 Access Control     | No (guards in Phase 21)            | —                                                                        |
| V5 Input Validation   | Yes                                | Zod on JWT_SECRET length; CHECK constraints on role/auth_provider/status |
| V6 Cryptography       | Yes                                | jose with HS256; JWT_SECRET via env (not hardcoded)                      |

### Known Threat Patterns for This Stack

| Pattern                                 | STRIDE                 | Standard Mitigation                                                                                 |
| --------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| Weak JWT secret                         | Spoofing               | Zod `.min(32)` on JWT_SECRET; app fails to start if absent                                          |
| Role escalation via invalid CHECK value | Elevation of Privilege | PostgreSQL CHECK constraint on `role` and `invitation.role`                                         |
| Owner role invited via invitation       | Elevation of Privilege | invitations.role CHECK excludes 'owner' value                                                       |
| Token forgery                           | Spoofing               | jose HS256 with secret from env; `jwtVerify` validates signature                                    |
| Migration rolls back existing data      | Tampering              | Migration 1 is near-empty (rename only); Migration 2 is additive only — no ALTER on existing tables |

---

## Assumptions Log

| #   | Claim                                                                                                                               | Section               | Risk if Wrong                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| A1  | TypeScript `nodenext` module resolution handles `jose` ESM exports correctly                                                        | ESM Compatibility     | Compilation error; workaround: add `"allowImportingTsExtensions": false` or adjust moduleResolution |
| A2  | Prisma generates an empty/comment-only migration SQL for the Tenant→Organization rename (since @@map("tenants") is already present) | Pitfall 3             | Migration might contain unwanted ALTER/RENAME; must inspect before applying                         |
| A3  | `generateOrgShortId` retry-up-to-10 pattern is sufficient for dev/test                                                              | Architecture Patterns | Very low risk in development; higher risk at scale (deferred, not Phase 18 concern)                 |
| A4  | Named Prisma relations required for Organization↔User circular FK                                                                   | Pitfall 7             | `npx prisma validate` will catch this immediately; low risk                                         |

---

## Open Questions

1. **Does Migration 1 generate any SQL?**
   - What we know: `@@map("tenants")` is already on the `Tenant` model. Prisma rename detection compares the model name in schema vs. migration history.
   - What's unclear: Whether Prisma's migration engine generates any SQL for the model rename, or produces a pure comment-only file.
   - Recommendation: Run `npx prisma migrate dev --create-only --name rename_tenant_to_organization`, inspect the output SQL before applying. If non-empty with unexpected ALTER, abort.

2. **Does the Organization model need `shortId` as @unique globally or just per-db?**
   - What we know: D-03 says "unique per database." D-04 says the counter increments per-prefix.
   - What's unclear: Whether the unique constraint should be `@@unique([shortId])` or `@@unique([shortId])` — they are equivalent for a single constraint. But does uniqueness need to be scoped to organization in any way?
   - Recommendation: Global uniqueness (`@@unique([shortId])`) per D-03. The prefix is derived from org name which already provides soft uniqueness.

---

## Project Constraints (from CLAUDE.md)

| Directive                                                           | Impact on Phase 18                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| TypeScript only                                                     | All new files in TypeScript                                                                                   |
| NestJS 11                                                           | Use `@Injectable()`, `@Module()`, NestJS DI patterns                                                          |
| Prisma 7                                                            | Use Prisma 7 API; `prisma.organization.upsert()` after rename                                                 |
| PostgreSQL 16                                                       | `TIMESTAMPTZ`, `UUID`, `TEXT` column types                                                                    |
| text + CHECK constraints over PostgreSQL ENUMs                      | Confirmed for role, auth_provider, status fields                                                              |
| no binary blobs in DB                                               | Confirmed — no password_hash, no binary fields                                                                |
| `updated_at` via Prisma `@updatedAt`                                | Use `@updatedAt` on Organization, User, Invitation models                                                     |
| `tenant_id` on every table from day 1                               | New User/Invitation tables use `organization_id` (FK to tenants table) — consistent with multi-tenant pattern |
| camelCase Prisma + `@map("snake_case")`                             | All new fields follow this convention (e.g., `organizationId @map("organization_id")`)                        |
| UUID primary keys with `@default(dbgenerated("gen_random_uuid()"))` | Use on all new models                                                                                         |

---

## Sources

### Primary (HIGH confidence)

- Codebase: `prisma/schema.prisma` — current Tenant model with `@@map("tenants")` confirmed
- Codebase: `src/config/env.ts` — Zod schema structure for env validation; extension point identified
- Codebase: `package.json` — jest config including `transformIgnorePatterns`, ts-jest 29.4.6
- Codebase: `tsconfig.json` — `module: "nodenext"`, `moduleResolution: "nodenext"`
- Codebase: `Dockerfile` — `FROM node:22-alpine`; Docker runtime is Node 22.22.2
- Codebase: `prisma/seed.ts` — `prisma.tenant.upsert()` at line 91 confirmed
- npm registry: `jose@6.2.2` — current latest version confirmed
- npm registry: `jsonwebtoken@9.0.3` — current latest (for comparison)

### Secondary (MEDIUM confidence)

- [jose GitHub](https://github.com/panva/jose) — ESM-only, zero deps, `SignJWT`/`jwtVerify` async API
- [WebSearch: Node 22 require(esm)](https://blog.arcjet.com/nodejs-22-support-esm-require-for-nestjs/) — Node 22.12+ native require(esm) support confirmed
- [WebSearch: Node:22-alpine version](https://hub.docker.com/_/node/) — 22.22.2 is current tag

### Tertiary (LOW confidence)

- Prisma empty migration behavior for @@map rename — not directly verified; based on knowledge of Prisma's migration engine behavior

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — jose, Prisma 7, zod all verified in registry and codebase
- Architecture: HIGH — patterns derived from existing codebase conventions + jose official API
- ESM/CJS compatibility: HIGH — Node 22.22.2 verified; `transformIgnorePatterns` fix verified in codebase
- Plan corrections: HIGH — payload field mismatch confirmed by reading 18-01-PLAN.md against D-17
- Pitfalls: MEDIUM — Prisma migration behavior for rename is assumed based on training knowledge

**Research date:** 2026-04-09
**Valid until:** 2026-05-09 (jose API is stable; Prisma 7 is current)
