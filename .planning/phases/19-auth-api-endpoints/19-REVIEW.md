---
phase: 19-auth-api-endpoints
reviewed: 2026-04-11T00:00:00Z
depth: standard
files_reviewed: 18
files_reviewed_list:
  - .env.example
  - docker-compose.yml
  - package.json
  - prisma/migrations/20260411000000_add_onboarding_completed_at/migration.sql
  - prisma/schema.prisma
  - src/auth/auth.controller.ts
  - src/auth/auth.module.ts
  - src/auth/auth.service.ts
  - src/auth/email.service.ts
  - src/auth/invitation.service.ts
  - src/auth/session.guard.ts
  - src/auth/team.controller.ts
  - src/auth/team.service.ts
  - src/auth/jwt.service.ts
  - src/auth/utils/generate-short-id.ts
  - src/config/env.ts
  - src/main.ts
  - src/storage/storage.service.ts
findings:
  critical: 3
  warning: 5
  info: 4
  total: 12
status: issues_found
---

# Phase 19: Code Review Report

**Reviewed:** 2026-04-11T00:00:00Z
**Depth:** standard
**Files Reviewed:** 18
**Status:** issues_found

## Summary

This phase adds the full auth surface: Google sign-in, magic-link login, invitation flow, team management, and onboarding. The architecture is sound — httpOnly cookies, jose for JWT, Redis for one-time magic-link tokens, and soft-delete for user revocation. Most critical paths are covered. However, several security issues warrant attention before production deployment: the dev stub path accepts unauthenticated arbitrary input in production if `GOOGLE_CLIENT_ID` is blank (which is the default in `.env.example`), the magic-link verify endpoint has a TOCTOU race condition on one-time use, role validation is absent when creating or changing roles, and logo uploads have no MIME or file-size validation.

---

## Critical Issues

### CR-01: Dev stub active in production when `GOOGLE_CLIENT_ID` is blank

**File:** `src/auth/auth.service.ts:39`
**Issue:** The condition `if (!clientId || !isProd)` activates the dev stub (parse `access_token` as JSON to extract `{email, name}`) whenever `GOOGLE_CLIENT_ID` is absent — regardless of `NODE_ENV`. The `.env.example` ships with `GOOGLE_CLIENT_ID=   ` (blank). If a production deployment omits or leaves this variable blank, any caller can sign in as any email by POSTing a crafted base64 payload. No Google token is ever validated.

**Fix:**
```typescript
// In fetchGoogleUserInfo — gate the stub on NODE_ENV only; require clientId in production
const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
const isProd = this.configService.get<string>('NODE_ENV') === 'production';

if (isProd && !clientId) {
  throw new UnauthorizedException('Google Sign-In is not configured');
}

if (!isProd) {
  // dev stub — parse access_token as JSON { email, name }
  // ... existing stub logic ...
}

// Production path: call Google UserInfo API
```

Additionally, add `GOOGLE_CLIENT_ID: z.string().min(1)` as required (not optional) in `src/config/env.ts` and validate the `aud` claim in the Google response against `clientId`.

---

### CR-02: Magic-link one-time-use has a TOCTOU race condition

**File:** `src/auth/invitation.service.ts:56-58`
**Issue:** `GET` and `DEL` are two separate Redis calls. Between `redis.get(redisKey)` and `redis.del(redisKey)`, a concurrent second request using the same token will also receive the userId before the key is deleted. This allows a magic link to be used more than once if the client (or an attacker) fires two requests simultaneously.

**Fix:** Use an atomic `GETDEL` command (available in Redis 6.2+, which ships with this stack's Redis 7):
```typescript
async verifyMagicLink(token: string): Promise<{ userId: string } | null> {
  const redisKey = `ml:${token}`;
  const userId = await this.redis.getdel(redisKey); // atomic: get + delete in one round-trip
  if (!userId) return null;
  return { userId };
}
```

---

### CR-03: No role value validation when creating invitations or changing roles

**File:** `src/auth/team.service.ts:55-118` (createInvitation), `src/auth/team.service.ts:130-150` (changeRole)
**Issue:** The `role` parameter is written directly to the database without validation. An owner could create an invitation with `role: "owner"` or an arbitrary string like `role: "superadmin"`, neither of which is in the accepted set `['owner', 'admin', 'member', 'viewer']`. Accepting `owner` via invitation is a privilege escalation vector — it creates a second owner without the explicit ownership-transfer flow.

**Fix:**
```typescript
// Add at the top of createInvitation and changeRole:
const ALLOWED_ROLES = ['admin', 'member', 'viewer']; // 'owner' is not grantable via invitation
if (!ALLOWED_ROLES.includes(role)) {
  throw new BadRequestException({ code: 'INVALID_ROLE', message: `Role must be one of: ${ALLOWED_ROLES.join(', ')}` });
}
```

For `changeRole`, allow `['admin', 'member', 'viewer']` (owner cannot be assigned via this endpoint either).

---

## Warnings

### WR-01: Logo upload has no MIME type or file-size guard

**File:** `src/auth/auth.controller.ts:72-82`, `src/auth/auth.service.ts:183-184`
**Issue:** `FileInterceptor('logo')` accepts any file type and any size. `storageService.uploadLogoFromBuffer` also has no validation (unlike `uploadFromBuffer` which checks MIME types). A user could upload a large binary or a file type that becomes a stored XSS vector if a CDN serves it without content-type enforcement.

**Fix:**
```typescript
// In auth.controller.ts — add size and MIME validation before calling completeOnboarding:
const ALLOWED_LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

if (logo) {
  if (!ALLOWED_LOGO_MIMES.includes(logo.mimetype)) {
    return { error: { code: 'INVALID_FILE_TYPE', message: 'Logo must be PNG, JPEG, WebP, or SVG' } };
  }
  if (logo.size > MAX_LOGO_BYTES) {
    return { error: { code: 'FILE_TOO_LARGE', message: 'Logo must be under 2 MB' } };
  }
}
```

Alternatively pass a `limits` and `fileFilter` option to `FileInterceptor`.

---

### WR-02: `generateOrgShortId` uses a non-transactional prisma instance inside a transaction

**File:** `src/auth/auth.service.ts:100`, `src/auth/utils/generate-short-id.ts:18`
**Issue:** Inside `prisma.$transaction(async (tx) => { ... })`, the code calls `generateOrgShortId(orgName, this.prisma)`. The function receives `this.prisma` (the outer client), not `tx` (the transaction client). The uniqueness check in `generateOrgShortId` therefore runs **outside** the transaction, making the shortId uniqueness guarantee non-atomic. Under concurrent sign-ups, two orgs could be assigned the same `shortId` — the DB unique constraint would catch it, but the transaction would fail with an unhandled DB error instead of a clean conflict message.

**Fix:**
```typescript
// Pass tx instead of this.prisma:
const org = await tx.organization.create({
  data: {
    name: orgName,
    shortId: await generateOrgShortId(orgName, tx as PrismaService),
  },
});
```

Alternatively, accept `PrismaClient | Prisma.TransactionClient` in the function signature.

---

### WR-03: `acceptInvite` does not handle a user already existing for the invited email

**File:** `src/auth/invitation.service.ts:103-116`
**Issue:** `tx.user.create` will throw a unique-constraint error (`idx_users_org_email`) if a user with the same `(organizationId, email)` already exists — for example, if a user was previously soft-deleted (isActive=false) and then re-invited, or if `acceptInvite` is called twice before the invitation status is updated in the same transaction. The error surfaces as a raw Prisma P2002 rather than an application-level conflict response.

**Fix:**
```typescript
// Before tx.user.create, check for an existing inactive user and reactivate instead:
const existingUser = await tx.user.findFirst({
  where: { organizationId: invitation.organizationId, email: invitation.email },
});
if (existingUser) {
  if (existingUser.isActive) {
    throw new ConflictException({ code: 'ALREADY_MEMBER', message: 'User is already a member' });
  }
  const user = await tx.user.update({
    where: { id: existingUser.id },
    data: { isActive: true, role: invitation.role },
  });
  await tx.invitation.update({ where: { id: invitation.id }, data: { status: 'accepted' } });
  return { user, org: invitation.organization };
}
// ... existing create path
```

---

### WR-04: `verifyMagicLink` endpoint in controller does not distinguish expired vs. never-existed

**File:** `src/auth/auth.controller.ts:103-107`
**Issue:** The comment at line 105 acknowledges the ambiguity, but both "TTL expired" and "never existed" return `404 NOT_FOUND`. The original design note (visible in the comment) intended a `410 Gone` for the expired case, but that distinction is lost because `verifyMagicLink` returns `null` for both scenarios. The user experience suffers — "link expired" and "link invalid" warrant different UI messages.

**Fix:**
```typescript
// In invitation.service.ts, distinguish expired from not-found by storing expiry metadata,
// or change the return type:
async verifyMagicLink(token: string): Promise<{ userId: string } | 'not_found' | 'expired'> {
  const redisKey = `ml:${token}`;
  const userId = await this.redis.getdel(redisKey);
  if (!userId) return 'not_found'; // TTL expiry or never existed — Redis gives no distinction
  // ... (if expiry metadata is stored separately, check it here)
  return { userId };
}
```

Alternatively, store an expiry timestamp alongside the userId so the controller can distinguish the cases. Note: if atomic `GETDEL` is adopted (CR-02), the same fix applies.

---

### WR-05: Email transport is created on every send — no connection reuse

**File:** `src/auth/email.service.ts:16-27`
**Issue:** `createTransport()` is called inside `sendOrLog()`, which is called on every email send. A new `nodemailer` transport with a new TCP connection is created per email. For invitation flows this is low-volume, but it means no SMTP connection pooling and a small resource leak if the transport is not explicitly closed.

**Fix:**
```typescript
// Instantiate the transport once in the constructor and reuse it:
private readonly transport: nodemailer.Transporter | null;

constructor(private readonly configService: ConfigService) {
  this.frontendUrl = ...;
  this.isDev = ...;
  const host = this.configService.get<string>('SMTP_HOST');
  this.transport = host ? nodemailer.createTransport({ host, port: ..., auth: { ... } }) : null;
}
```

---

## Info

### IN-01: `console.error` used instead of NestJS Logger in TeamService

**File:** `src/auth/team.service.ts:109`
**Issue:** `console.error('[TeamService] Failed to send invitation email:', err)` bypasses the application's pino/NestJS logger, so this error won't appear in structured logs with correlation context.

**Fix:**
```typescript
private readonly logger = new Logger(TeamService.name);
// ...
} catch (err) {
  this.logger.error({ err }, 'Failed to send invitation email');
}
```

---

### IN-02: `sign` method is public and not aligned with its usage pattern

**File:** `src/auth/jwt.service.ts:22`
**Issue:** The `sign(payload, expiresIn)` method is `public` and accepts any expiry string. In practice all callers should use the typed `signAccessToken`/`signRefreshToken` wrappers. Leaving `sign` public allows callers outside the module to create tokens with arbitrary expiry strings.

**Fix:** Change `sign` to `private`:
```typescript
private async sign(payload: JwtPayload, expiresIn = '15m'): Promise<string> {
```

---

### IN-03: Magic-link email points to frontend route, not backend verify endpoint

**File:** `src/auth/email.service.ts:54`
**Issue:** The magic link URL is `${this.frontendUrl}/auth/magic-link/verify?token=...`. The actual verify endpoint is `GET /api/auth/magic-link/verify` on the backend. This means the frontend must proxy or redirect the request. Whether this is intentional (frontend handles the redirect) or a bug depends on the frontend routing — it should be documented explicitly.

**Fix:** If the intent is for the frontend to handle the route and then call the API, add a comment clarifying this. If the link should go directly to the API, use `${this.backendUrl}/api/auth/magic-link/verify?token=...`.

---

### IN-04: Docker Compose exposes PostgreSQL and Redis ports to host network

**File:** `docker-compose.yml:64`, `docker-compose.yml:88`
**Issue:** `ports: - '5432:5432'` and `ports: - '6379:6379'` expose the database and cache directly on the host's network interfaces. In a production deployment, these services should not be reachable outside the Docker network. Firewall rules may not be sufficient — the safer default is to remove host port bindings for these services.

**Fix:** Remove the `ports:` entries from the `postgres` and `redis` services in production. For local development use a separate `docker-compose.override.yml` to re-add them, or use `docker exec` / `prisma studio` tunneling.

---

_Reviewed: 2026-04-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
