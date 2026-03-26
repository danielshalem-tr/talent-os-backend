# Backend Spec: Add Candidate API

> ⚠️ **Important note for the backend agent:** This spec was written without direct access to the existing backend codebase. Before implementing anything, validate every assumption here against the real code — including field names, existing controller/service patterns, Prisma schema column names, Cloudflare integration implementation, and the `tenantId` resolution pattern. If you find any contradiction between this spec and the existing code, the existing code takes precedence. Stop and clarify with the user before proceeding if anything is ambiguous.

---

## 1. POST /candidates

### Purpose
Create a new candidate and immediately link them to an existing job. This must create both a `Candidate` record and an `Application` record in a single atomic transaction.

### Request

The endpoint must support both `multipart/form-data` (when a CV file is attached) and `application/json` (when no file is attached).

#### Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `full_name` | string | ✅ | min length 1 |
| `email` | string \| null | | must be valid email format if provided |
| `phone` | string \| null | | |
| `current_role` | string \| null | | |
| `location` | string \| null | | |
| `years_experience` | number \| null | | integer, 0–50 |
| `skills` | string[] | | defaults to `[]` if omitted |
| `ai_summary` | string \| null | | stored in `Candidate.aiSummary` |
| `cv_file` | File \| null | | multipart only; `.pdf`, `.doc`, `.docx` |
| `source` | string | ✅ | one of: `linkedin`, `website`, `agency`, `referral`, `direct` |
| `source_agency` | string \| null | | relevant when `source = "agency"` |
| `job_id` | string (UUID) | ✅ | the job to link the candidate to |

### Response — 201 Created

```ts
{
  id: string
  tenant_id: string
  full_name: string
  email: string | null
  phone: string | null
  current_role: string | null
  location: string | null
  years_experience: number | null
  skills: string[]
  cv_text: string | null       // null on manual create
  cv_file_url: string | null   // Cloudflare URL if file uploaded, else null
  source: string
  source_agency: string | null
  source_email: string | null  // null on manual create
  metadata: object | null      // null on manual create
  created_at: string           // ISO 8601
  updated_at: string           // ISO 8601
  application_id: string       // UUID of the Application record created
}
```

### Error Responses

| Status | When |
|---|---|
| `400` | Missing required fields, invalid email format, `years_experience` out of range, invalid file type |
| `404` | `job_id` does not exist for this tenant |
| `409` | A candidate with the same email already exists for this tenant |

---

## 2. Database Operations

All of the following must happen in a **single transaction**. If any step fails, the entire operation must roll back.

1. Create `Candidate` record with `tenantId` from request context
2. If `cv_file` is present — upload to Cloudflare, store the resulting public URL in `cv_file_url`
3. Create `Application` record with:
   - `candidateId` → the newly created candidate
   - `jobId` → the `job_id` from the request
   - `tenantId` → from request context
   - `stage` → `"new"` (default)

### Why the Application record is critical

The `Application` table is the join between `Candidate` and `Job`. Without it, a manually added candidate is invisible to any job-centric view. The kanban board that displays candidates per job per stage depends entirely on this relationship — a candidate without an `Application` record will not appear on any board regardless of which job they were added under. Creating the `Application` atomically with the `Candidate` ensures the candidate is visible and trackable from the moment they enter the system.

---

## 3. CV File Upload

The backend already handles Cloudflare file storage via the email webhook flow. This endpoint requires the same capability triggered from a direct HTTP upload.

**Accepted MIME types:** `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`

**Accepted extensions:** `.pdf`, `.doc`, `.docx`

Validate file type server-side and return `400` on invalid type. The returned `cv_file_url` must be a publicly accessible URL (or a signed URL with sufficient TTL for display).

---

## 4. GET /jobs/list — New Endpoint

The existing `GET /jobs` returns full job objects and should not be modified. Add a new lightweight endpoint for populating job selectors in the UI.

```
GET /jobs/list
```

**Response — 200 OK:**

```ts
{
  jobs: Array<{
    id: string
    title: string
    department: string | null
  }>
}
```

- Returns only jobs with `status = "open"` for the current tenant
- No pagination required for MVP
