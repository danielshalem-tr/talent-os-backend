# Requirements: Triolla Talent OS — Backend (v2.0)

**Defined:** 2026-04-07
**Core Value:** Organization signup, admin-managed user accounts, and role-based recruiter access to the platform.

## v2.0 Requirements

### User Management & Organization Setup

**UM-01:** Organization signup endpoint accepts org name, admin email, admin password; creates new tenant with auto-generated `shortId` for future email routing

**UM-02:** Organization model includes: `id` (UUID), `name` (text), `shortId` (unique, slug-like), `created_at`, `updated_at`, `created_by_user_id` (FK to users)

**UM-03:** Users table includes: `id`, `email`, `password_hash`, `tenant_id` (FK), `role` (text: admin|recruiter|viewer), `full_name`, `is_active`, `created_at`, `updated_at`

**UM-04:** Unique constraint on `(tenant_id, email)` prevents duplicate user accounts per organization

**UM-05:** Admin user created as first user during org signup; no additional signup required for admin

### Authentication & Sessions

**AUTH-01:** JWT-based authentication with access token (15m) + refresh token (7d); tokens signed with `process.env.JWT_SECRET`

**AUTH-02:** POST /auth/signup accepts `orgName`, `adminEmail`, `adminPassword`; validates password strength (min 8 chars, 1 uppercase, 1 number)

**AUTH-03:** POST /auth/login accepts `email`, `password`; returns `accessToken`, `refreshToken`, `user` object (id, email, role, org_id)

**AUTH-04:** POST /auth/refresh accepts refresh token; returns new access token; invalidates old token

**AUTH-05:** POST /auth/logout invalidates all tokens for user; requires valid access token

**AUTH-06:** JWT verification middleware on all API endpoints except /auth/signup and /auth/login; 401 Unauthorized for missing/invalid tokens

### Role-Based Access Control

**RBAC-01:** Three roles: `admin` (full access, user management), `recruiter` (view candidates/jobs, update applications, cannot manage users), `viewer` (read-only)

**RBAC-02:** Admin role can: create users, update user roles, delete users, manage jobs, view all candidates

**RBAC-03:** Recruiter role can: view own org's candidates, update application stages, cannot manage other users

**RBAC-04:** Viewer role can: read-only access to candidates and jobs; no write permissions

**RBAC-05:** Role checked via middleware on protected endpoints; 403 Forbidden if insufficient permissions

### Admin User Management

**ADMIN-01:** GET /api/admin/users returns all users for org with `id`, `email`, `full_name`, `role`, `is_active`, `created_at`

**ADMIN-02:** POST /api/admin/users creates new user in org; admin provides `email`, `full_name`, `role` (recruiter|viewer); system generates temporary password and sends invite email

**ADMIN-03:** PUT /api/admin/users/:id updates user `full_name`, `role`, `is_active` status atomically

**ADMIN-04:** DELETE /api/admin/users/:id soft-deletes user (is_active=false); no hard delete

**ADMIN-05:** GET /api/admin/users/:id returns single user with all fields

### API Protocol Updates

**API-01:** All existing endpoints (`/api/candidates`, `/api/jobs`, `/api/applications`) require valid JWT and enforce tenant isolation via token's `tenant_id`

**API-02:** Response format unchanged; add optional `user` object to GET /auth/login and POST /auth/signup responses

**API-03:** Error responses include `code` (string), `message` (string), `details` (optional object)

**API-04:** 401 Unauthorized for missing/invalid auth; 403 Forbidden for insufficient role permissions

---

**Status:** Defined; ready for phase planning
