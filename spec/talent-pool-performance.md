# Backend Performance Plan — Talent Pool (`/candidates`)

## Problems

### 1. Over-fetching in `findAll`

The `select` includes heavy joins that the list page doesn't need:

- `applications.scores` — only used to compute `ai_score` (MAX). Should be a DB-level subquery or denormalized field.
- `candidateStageSummaries` — only relevant on candidate profile page, not the list.
- `hiringStage.name` / `job.title` — needed, but could be flattened.

### 2. `status: { not: 'rejected' }` instead of `status: 'active'`

Negative conditions are less index-friendly. Switch to positive `status: 'active'` and ensure a DB index on `(tenantId, status)`.

### 3. `high-score` filter is post-query

All candidates are fetched, mapped, then filtered in JS. This filter is being removed per scope, but the pattern should not repeat.

### 4. Duplicate/unassigned counts computed client-side

The frontend iterates over the full candidate array to count duplicates and unassigned. The backend should return these counts directly.

### 5. Dead filters

`available` and `referred` filters add query complexity for features being removed from the UI.

---

## Changes

### C-1: Add `GET /candidates/counts`

New lightweight endpoint:

```
GET /candidates/counts
→ { total: number, duplicates: number, unassigned: number }
```

Two simple `COUNT` queries (one for `jobId IS NULL`, one for `duplicateFlags` with `reviewed: false`). Both filtered by `tenantId` and `status: 'active'`.

The alerts component will call this independently from the main list, decoupling counts from search/filter state.

### C-2: Slim down `findAll` select

Remove from the list endpoint:

- `candidateStageSummaries` — move to `findOne` only
- `applications.scores` — replace with a Prisma raw subquery or denormalize `ai_score` on the candidate record at write-time (preferred — score is written once per application)

Keep: `duplicateFlags` (needed for `is_duplicate` badge), `hiringStage.name`, `job.title`.

### C-3: Switch status filter to positive match

```ts
where.status = 'active';
```

Add Prisma migration or raw SQL to create index:

```sql
CREATE INDEX idx_candidate_tenant_status ON "Candidate" ("tenantId", "status");
```

### C-4: Remove dead filters

Remove `available`, `referred`, and `high-score` from `CandidateFilter` type. Remaining valid filters: `all`, `duplicates`.

`unassigned` already handled via `?unassigned=true` query param — keep as-is.

### C-5: Denormalize `ai_score`

Add `aiScore Float?` column to `Candidate`. Update it when `CandidateJobScore` is created (in `createCandidate` and `updateCandidate` reassignment flow). This eliminates the `applications → scores` join on every list fetch.

---

## Migration order

1. C-3 (status index) — zero risk, immediate query improvement
2. C-4 (remove dead filters) — coordinated with frontend filter removal
3. C-1 (counts endpoint) — unblocks frontend alert decoupling
4. C-2 (slim select) — reduces payload size
5. C-5 (denormalize ai_score) — optional, biggest select reduction but needs migration
